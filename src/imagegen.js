// imagegen.js — chatgpt.com f/conversation 生图协议
//
// 完整链路:
//   1. POST /backend-api/sentinel/chat-requirements → chat_token + PoW (SHA3-512)
//   2. POST /backend-api/f/conversation/prepare → conduit_token  (system_hints: [picture_v2])
//   3. POST /backend-api/f/conversation (SSE)         → 解析 file-service:// / sediment:// 引用
//   4. 若 SSE 无直出: 轮询 GET /backend-api/conversation/{id} (每 3s, 最多 120s)
//   5. GET /backend-api/files/{fid}/download           → 签名 URL
//   6. 签名 URL 存入内存缓存 → 通过 /p/img/:token 代理 endpoint 返回图像
//
// 认证: Codex access_token (Bearer) + Oai-Device-Id / Oai-Session-Id
// 参考: gpt2api (internal/upstream/chatgpt/image.go, internal/image/runner.go)

import { createHash, randomUUID } from 'crypto';

import { updateImageQuota, recordImageUsage, getLocalImageQuota } from './usageTracker.js';
import { markImageQuotaExhausted } from './accountStatus.js';
import { getProxyAgent } from './proxyAgent.js';
// ── 常量 ────────────────────────────────────────────────────

const BASE_URL = 'https://chatgpt.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const CLIENT_VERSION = 'prod-be885abbfcfe7b1f511e88b3003d9ee44757fbad';
const CLIENT_BUILD_NUM = '5955942';

const POW_PREFIX_REQ = 'gAAAAAC';
const POW_PREFIX_PRF = 'gAAAAAB';
const POW_DIFFICULTY = '0fffff';
const MAX_REQUIREMENTS_ITER = 500000;
const MAX_PROOF_ITER = 100000;
// ── 请求头 ──────────────────────────────────────────────────

function makeHeaders(authToken, accountId, deviceId, sessionId, targetPath) {
  return {
    'Authorization': `Bearer ${authToken}`,
    // Chatgpt-Account-Id 不适用于 f/conversation 端点
    'Oai-Device-Id': deviceId,
    ...(sessionId ? { 'Oai-Session-Id': sessionId } : {}),
    'Oai-Language': 'zh-CN',
    'Oai-Client-Version': CLIENT_VERSION,
    'Oai-Client-Build-Number': CLIENT_BUILD_NUM,
    'User-Agent': USER_AGENT,
    'Origin': 'https://chatgpt.com',
    'Referer': 'https://chatgpt.com/',
    ...(targetPath ? { 'X-Openai-Target-Path': targetPath, 'X-Openai-Target-Route': targetPath } : {}),
  };
}

// ── PoW ─────────────────────────────────────────────────────

function sha3_512(data) {
  return createHash('sha3-512').update(data).digest();
}

function hexToBytes(hex) {
  const buf = Buffer.alloc(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) buf[i >> 1] = parseInt(hex.substr(i, 2), 16);
  return buf;
}

function generatePOWConfig() {
  const cores = [16, 24, 32];
  const screens = [3000, 4000, 6000];
  const navKeys = [
    'webdriver−false','vendor−Google Inc.','cookieEnabled−true',
    'pdfViewerEnabled−true','hardwareConcurrency−32',
    'language−zh-CN','mimeTypes−[object MimeTypeArray]',
    'userAgentData−[object NavigatorUAData]',
  ];
  const winKeys = ['innerWidth','innerHeight','devicePixelRatio','screen',
    'chrome','location','history','navigator'];
  const ri = (max) => Math.floor(Math.random() * max);
  const now = new Date();
  const ts = now.toUTCString().replace('GMT', 'GMT+0000 (UTC)');
  return [
    cores[ri(cores.length)] + screens[ri(screens.length)],
    ts, null, Math.random(), USER_AGENT, null,
    'dpl=1440a687921de39ff5ee56b92807faaadce73f13',
    'en-US','en-US,zh-CN',0,
    navKeys[ri(navKeys.length)],'location',
    winKeys[ri(winKeys.length)],Date.now()+Math.random(),
    randomUUID(),'',8,Math.floor(now.getTime()/1000),
  ];
}

function solvePow(config, seed, diff, maxIter, prefix) {
  const target = hexToBytes(diff);
  const diffLen = diff.length;
  const seedB = Buffer.from(seed);
  const p1 = JSON.stringify([config[0],config[1],config[2]]).slice(0,-1)+',';
  const mid = JSON.stringify([config[4],config[5],config[6],config[7],config[8]]);
  const p2 = ','+mid.slice(1,-1)+',';
  const p3 = ','+JSON.stringify([config[10],config[11],config[12],config[13],config[14],config[15],config[16],config[17]]).slice(1);

  for (let i = 0; i < maxIter; i++) {
    const buf = p1 + String(i) + p2 + String(i>>1) + p3;
    const b64 = Buffer.from(buf).toString('base64');
    const hash = sha3_512(Buffer.concat([seedB, Buffer.from(b64)]));
    let ok = true;
    for (let j = 0; j < target.length && j < hash.length; j++) {
      if (hash[j] > target[j]) { ok = false; break; }
      if (hash[j] < target[j]) break;
    }
    if (ok) return prefix + b64;
  }
  return null;
}

function generateRequirementsToken() {
  const config = generatePOWConfig();
  const seed = String(Math.random());
  const r = solvePow(config, seed, POW_DIFFICULTY, MAX_REQUIREMENTS_ITER, POW_PREFIX_REQ);
  if (r) return r;
  return POW_PREFIX_REQ + 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(`"${seed}"`).toString('base64');
}

function solveProofToken(seed, difficulty) {
  const config = generatePOWConfig();
  const r = solvePow(config, seed, difficulty, MAX_PROOF_ITER, POW_PREFIX_PRF);
  if (r) return r;
  return POW_PREFIX_PRF + 'wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D' + Buffer.from(`"${seed}"`).toString('base64');
}

// ── fetch 封装 ──────────────────────────────────────────────

async function apiFetch(url, method, opts) {
  const { authToken, accountId, deviceId, sessionId, body, extraHeaders,
    accept, targetPath, timeoutMs = 30000, proxyUrl } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = makeHeaders(authToken, accountId, deviceId, sessionId, targetPath);
    headers['Accept'] = accept || '*/*';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const dispatcher = getProxyAgent(proxyUrl);
    const init = { method, headers, signal: controller.signal, dispatcher };
    if (body) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

// ── API 步骤 ────────────────────────────────────────────────

async function chatRequirements(authToken, accountId, deviceId, sessionId, proxyUrl) {
  const path = '/backend-api/sentinel/chat-requirements';
  const res = await apiFetch(BASE_URL + path, 'POST', {
    authToken, accountId, deviceId, sessionId, proxyUrl,
    body: { p: generateRequirementsToken() }, targetPath: path, timeoutMs: 20000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`chat-req ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

async function prepareFConversation(authToken, accountId, deviceId, sessionId,
                                    prompt, model, chatToken, proofToken, convId, parentMsgId, proxyUrl) {
  const path = '/backend-api/f/conversation/prepare';
  const payload = {
    action: 'next', fork_from_shared_post: false,
    parent_message_id: parentMsgId || randomUUID(),
    model: model || 'auto',
    client_prepare_state: 'success',
    timezone_offset_min: -480, timezone: 'Asia/Shanghai',
    conversation_mode: { kind: 'primary_assistant' },
    system_hints: ['picture_v2'],
    partial_query: {
      id: randomUUID(),
      author: { role: 'user' },
      content: { content_type: 'text', parts: [prompt] },
    },
    supports_buffering: true, supported_encodings: ['v1'],
    client_contextual_info: { app_name: 'chatgpt.com' },
  };
  if (convId) payload.conversation_id = convId;

  const eh = { 'Openai-Sentinel-Chat-Requirements-Token': chatToken };
  if (proofToken) eh['Openai-Sentinel-Proof-Token'] = proofToken;

  const res = await apiFetch(BASE_URL + path, 'POST', {
    authToken, accountId, deviceId, sessionId, proxyUrl,
    body: payload, targetPath: path, extraHeaders: eh, timeoutMs: 25000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`prepare ${res.status}: ${t.slice(0, 300)}`);
  }
  const d = await res.json();
  return d.conduit_token || '';
}

async function streamFConversation(authToken, accountId, deviceId, sessionId,
                                    prompt, model, chatToken, proofToken, conduitToken, convId, parentMsgId, proxyUrl) {
  const path = '/backend-api/f/conversation';
  const msgId = randomUUID();
  const payload = {
    action: 'next',
    messages: [{
      id: msgId, author: { role: 'user' },
      create_time: Date.now() / 1000,
      content: { content_type: 'text', parts: [prompt] },
      metadata: {
        developer_mode_connector_ids: [], selected_github_repos: [],
        selected_all_github_repos: false,
        system_hints: ['picture_v2'],
        serialization_metadata: { custom_symbol_offsets: [] },
      },
    }],
    parent_message_id: parentMsgId || randomUUID(),
    model: model || 'auto',
    client_prepare_state: 'sent',
    timezone_offset_min: -480, timezone: 'Asia/Shanghai',
    conversation_mode: { kind: 'primary_assistant' },
    enable_message_followups: true,
    system_hints: ['picture_v2'],
    supports_buffering: true, supported_encodings: ['v1'],
    client_contextual_info: {
      is_dark_mode: false, time_since_loaded: 1200,
      page_height: 1072, page_width: 1724,
      pixel_ratio: 1.2, screen_height: 1440, screen_width: 2560,
      app_name: 'chatgpt.com',
    },
    paragen_cot_summary_display_override: 'allow',
    force_parallel_switch: 'auto',
  };
  if (convId) payload.conversation_id = convId;

  const eh = {
    'Openai-Sentinel-Chat-Requirements-Token': chatToken,
    'X-Oai-Turn-Trace-Id': randomUUID(),
  };
  if (proofToken) eh['Openai-Sentinel-Proof-Token'] = proofToken;
  if (conduitToken) eh['Openai-Sentinel-Conduit-Token'] = conduitToken;

  const res = await apiFetch(BASE_URL + path, 'POST', {
    authToken, accountId, deviceId, sessionId, proxyUrl,
    body: payload, targetPath: path,
    extraHeaders: eh, accept: 'text/event-stream', timeoutMs: 180000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`f/conv ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.body;
}

// ── SSE 解析 ────────────────────────────────────────────────

async function parseImageSSE(stream, debug = false) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const result = { conversationID: '', fileIDs: [], sedimentIDs: [], imageGenTaskID: '' };
  const seen = {};
  const debugSamples = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const msg = JSON.parse(data);
        if (msg.conversation_id && !result.conversationID) result.conversationID = msg.conversation_id;
        if (msg.message?.metadata?.image_gen_async && !result.imageGenTaskID)
          result.imageGenTaskID = msg.message.metadata.image_gen_async;

        const walk = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) { for (const it of obj) walk(it); return; }
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
              const fm = v.match(/file-service:\/\/([A-Za-z0-9_-]+)/);
              if (fm && !seen[fm[1]]) { seen[fm[1]] = true; result.fileIDs.push(fm[1]); }
              const sm = v.match(/sediment:\/\/([A-Za-z0-9_-]+)/);
              if (sm && !seen[sm[1]]) { seen[sm[1]] = true; result.sedimentIDs.push(sm[1]); }
            }
            if (k === 'asset_pointer' && typeof v === 'string' && v) {
              const fm = v.match(/file-service:\/\/([A-Za-z0-9_-]+)/);
              if (fm && !seen[fm[1]]) { seen[fm[1]] = true; result.fileIDs.push(fm[1]); }
              const sm = v.match(/sediment:\/\/([A-Za-z0-9_-]+)/);
              if (sm && !seen[sm[1]]) { seen[sm[1]] = true; result.sedimentIDs.push(sm[1]); }
            }
            walk(v);
          }
        };
        if (debug && debugSamples.length < 10) { debugSamples.push(JSON.stringify(msg).slice(0, 800)); }
        walk(msg);
      } catch (_) {}
    }
  }
  if (debug) result._debugSamples = debugSamples;
  return result;
}

// ── 轮询会话 ────────────────────────────────────────────────

async function pollConversationForImages(authToken, accountId, deviceId, sessionId, convID, expectedN, proxyUrl) {
  const path = `/backend-api/conversation/${convID}`;
  const maxWait = 90000; // 最多等 90s
  const interval = 3000;  // 每 3s 轮询一次
  const deadline = Date.now() + maxWait;

  const fileIDs = [];
  const sedIDs = [];
  const seen = {};
  let _warnedQuota = false;

  while (Date.now() < deadline) {
    const res = await apiFetch(BASE_URL + path, 'GET', {
      authToken, accountId, deviceId, sessionId, proxyUrl,
      targetPath: path, timeoutMs: 15000, accept: 'application/json',
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`poll ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();

    // 遍历 messages 找 file-service:// 引用
    const msgs = data.mapping ? Object.values(data.mapping) : (data.messages || []);
    for (const m of msgs) {
      const msg = m.message || m;
      if (!msg) continue;
      // 深度搜索
      const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { for (const it of obj) walk(it); return; }
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') {
            const fm = v.match(/file-service:\/\/([A-Za-z0-9_-]+)/);
            if (fm && !seen[fm[1]]) { seen[fm[1]] = true; fileIDs.push(fm[1]); }
            const sm = v.match(/sediment:\/\/([A-Za-z0-9_-]+)/);
            if (sm && !seen[sm[1]]) { seen[sm[1]] = true; sedIDs.push(sm[1]); }
          }
          if (k === 'asset_pointer' && typeof v === 'string' && v) {
            const fm = v.match(/file-service:\/\/([A-Za-z0-9_-]+)/);
            if (fm && !seen[fm[1]]) { seen[fm[1]] = true; fileIDs.push(fm[1]); }
            const sm = v.match(/sediment:\/\/([A-Za-z0-9_-]+)/);
            if (sm && !seen[sm[1]]) { seen[sm[1]] = true; sedIDs.push(sm[1]); }
          }
          walk(v);
        }
      };
      walk(msg);

      // 检测额度不足消息
      if (msg?.content?.parts) {
        const fullText = (Array.isArray(msg.content.parts) ? msg.content.parts : [msg.content.parts])
          .filter(p => typeof p === 'string')
          .join(' ');
        if (/hit the.*limit.*image|free plan limit|image.*quota.*exceeded|rate.limit.*image/i.test(fullText)) {
          markImageQuotaExhausted(accountId);
          return { fileIDs: [], sedimentIDs: [], exhausted: true };
        }
      }
    }

    if (fileIDs.length + sedIDs.length >= expectedN) break;

    // 超 30s 无结果且未警告过，可能额度不足
    if (Date.now() > deadline - maxWait + 30000 && fileIDs.length === 0 && sedIDs.length === 0 && !_warnedQuota) {
      _warnedQuota = true;
    }

    await new Promise(r => setTimeout(r, interval));
  }

  // 超时无结果，标记生图额度耗尽并跳过该账号 24h
  if (fileIDs.length === 0 && sedIDs.length === 0) {
    markImageQuotaExhausted(accountId);
  }
  return { fileIDs, sedimentIDs: sedIDs };
}

// ── 图像下载 ────────────────────────────────────────────────

async function getImageDownloadURL(authToken, accountId, deviceId, sessionId, convID, fileRef, proxyUrl) {
  let url;
  if (fileRef.startsWith('sed:')) {
    const fid = fileRef.slice(4);
    if (!convID) throw new Error('sediment download needs convID');
    url = `${BASE_URL}/backend-api/conversation/${convID}/attachment/${fid}/download`;
  } else {
    url = `${BASE_URL}/backend-api/files/${fileRef}/download`;
  }
  const path = new URL(url).pathname;
  const res = await apiFetch(url, 'GET', {
    authToken, accountId, deviceId, sessionId, proxyUrl, targetPath: path, timeoutMs: 20000,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`dl-url ${res.status}: ${t.slice(0, 200)}`);
  }
  const d = await res.json();
  return d.download_url || d.url || '';
}

export async function fetchImageBytes(url, authToken, accountId, deviceId, sessionId, proxyUrl = null) {
  // chatgpt.com 开头的 estuary/attachment 回源 URL 必须带认证头，否则 403
  const needAuth = url.startsWith(BASE_URL + '/');
  const headers = needAuth
    ? makeHeaders(authToken, accountId, deviceId, sessionId, '')
    : { 'User-Agent': USER_AGENT };
  headers['Accept'] = 'image/*,*/*;q=0.8';
  if (!needAuth) {
    headers['Referer'] = 'https://chatgpt.com/';
    headers['Origin'] = 'https://chatgpt.com';
  }
  const dispatcher = getProxyAgent(proxyUrl);
  const init = { headers, dispatcher };
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetch image ${res.status}`);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

// ── 内存缓存 ────────────────────────────────────────────────
// Map<token, { signedURL, authToken, accountId, deviceId, sessionId, expires }>

const imageCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟 TTL

export function storeImage(token, signedURL, authToken, accountId, deviceId, sessionId, proxyUrl = null) {
  imageCache.set(token, {
    signedURL, authToken, accountId, deviceId, sessionId, proxyUrl,
    expires: Date.now() + CACHE_TTL,
  });
  // 定期清理过期条目 (超过 200 条时触发)
  if (imageCache.size > 200) {
    for (const [k, v] of imageCache) if (Date.now() > v.expires) imageCache.delete(k);
  }
}

export function getCachedImage(token) {
  const entry = imageCache.get(token);
  if (!entry || Date.now() > entry.expires) {
    if (entry) imageCache.delete(token);
    return null;
  }
  return entry;
}

// ── 主入口 ──────────────────────────────────────────────────

export async function generateImage(openaiReq, auth) {
  const model = openaiReq.model || 'gpt-image-2';
  const prompt = String(openaiReq.prompt || '');
  const n = Math.min(Math.max(Number(openaiReq.n) || 1, 1), 10);
  const authToken = auth.accessToken;
  const accountId = auth.accountId;
  const proxyUrl = auth.proxyUrl || null;
  // 从 JWT 中解析 session_id（jwt.io 格式：header.payload.signature）
  let sessionId = auth.sessionId || '';
  if (!sessionId && authToken) {
    try {
      const parts = authToken.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        sessionId = payload.session_id || '';
      }
    } catch (_) {}
  }
  const deviceId = auth.deviceId || accountId;

  const cr = await chatRequirements(authToken, accountId, deviceId, sessionId, proxyUrl);

  // 检测并更新生图额度
  const limits = cr.limits_progress || [];
  // 本地生图计数（仅供参考，不阻止请求；只有后端实际返回额度不足时才标记）
  const localQuota = getLocalImageQuota(accountId);

  const chatToken = cr.token;
  let proofToken = '';
  if (cr.proofofwork?.required) {
    proofToken = solveProofToken(cr.proofofwork.seed, cr.proofofwork.difficulty);
  }
  let upstreamModel = model;
  if (cr.persona === 'chatgpt-freeaccount') upstreamModel = 'auto';

  const parentMsgId = randomUUID();
  const conduitToken = await prepareFConversation(
    authToken, accountId, deviceId, sessionId,
    prompt, upstreamModel, chatToken, proofToken, '', parentMsgId, proxyUrl);

  const sseStream = await streamFConversation(
    authToken, accountId, deviceId, sessionId,
    prompt, upstreamModel, chatToken, proofToken, conduitToken, '', parentMsgId, proxyUrl);

  const sse = await parseImageSSE(sseStream, true);
  

  // 如果 SSE 没直出 file-service，轮询会话获取图像
  let fileIDs = [...sse.fileIDs];
  let sedIDs = [...sse.sedimentIDs];
  let pollResult = null;
  if (fileIDs.length === 0 && sse.conversationID) {
    pollResult = await pollConversationForImages(authToken, accountId, deviceId, sessionId, sse.conversationID, n, proxyUrl);
    fileIDs = pollResult.fileIDs;
    sedIDs = pollResult.sedimentIDs;
  }

  const allRefs = [...fileIDs, ...sedIDs.map(id => `sed:${id}`)];
  // 轮询检测到额度不足
  if (pollResult?.exhausted) {
    throw new Error('账号生图额度已用尽，已自动标记跳过 (24h 后重置)。请稍后重试或更换账号。');
  }
  if (allRefs.length === 0) {
    const diag = `convID=${sse.conversationID||'(空)'} taskID=${sse.imageGenTaskID||'(空)'} files=${sse.fileIDs.length} seds=${sse.sedimentIDs.length} samples=${JSON.stringify((sse._debugSamples||[]).slice(0,5))}`;
    throw new Error('SSE 未返回图像文件引用 — ' + diag);
  }

  const targets = allRefs.slice(0, n);
  const data = [];
  for (const ref of targets) {
    try {
      const dlURL = await getImageDownloadURL(authToken, accountId, deviceId, sessionId, sse.conversationID, ref, proxyUrl);
      if (dlURL) {
        // 生成代理 token，存储签名 URL（带认证信息）
        const token = randomUUID().replace(/-/g, '');
        storeImage(token, dlURL, authToken, accountId, deviceId, sessionId, proxyUrl);
        data.push({ url: `${BASE_URL}/backend-api/codex/fake-placeholder` });
        // 改为用本地代理 URL——需要在外部设置 base
        data[data.length - 1]._token = token;
      }
    } catch (e) {
    }
  }
  if (data.length === 0) throw new Error('所有图像引用获取失败');

  // 记录生图成功
  recordImageUsage(accountId);

  // 返回 token 列表，由 proxy.js 构建完整代理 URL
  return {
    created: Math.floor(Date.now() / 1000),
    data,
  };
}
