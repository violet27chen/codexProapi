/**
 * 模型可用性探测器
 *
 * 从 Codex 后端动态获取模型目录，并逐个探测账号实际可用性。
 * 探测结果缓存 1 小时；可通过 /api/models/refresh 强制刷新。
 */
import { randomUUID } from 'crypto';
import { loadAccountsForProxy } from './accounts.js';
import { isAccountUnavailable, markAccountUnavailable } from './accountStatus.js';
import { refreshTokenByAccountId } from './tokenRefresh.js';
import { getProxyAgent } from './proxyAgent.js';
import { parseModelCatalog } from './modelCatalog.js';
import { createSSEParser } from './sse.js';

const BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const PROBE_TIMEOUT_MS = 12 * 1000;

// 与 proxy.js 完全一致的请求头，任何字段缺失都会被 ChatGPT 拒绝
const BROWSER_HEADERS = {
  'Accept': 'text/event-stream',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://chatgpt.com/',
  'Origin': 'https://chatgpt.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1',
  'OpenAI-Beta': 'responses=experimental',
  'originator': 'codex_cli_rs',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

let cache = {
  lastProbed: 0,
  inProgress: false,
  results: {}, // { modelId: { available, latency, reason?, probedAt } }
};
let modelIds = [];
let catalogError = null;
let probePromise = null; // 单飞：并发调用复用同一 promise
let probeGeneration = 0;

function clearModelCache() {
  cache.lastProbed = 0;
  cache.results = {};
  modelIds = [];
  catalogError = null;
}

export function invalidateModels() {
  probeGeneration++;
  clearModelCache();
  const pendingProbe = probePromise;
  if (pendingProbe) {
    void pendingProbe.finally(() => {
      if (cache.lastProbed === 0 && !probePromise) {
        probeAll().catch((e) => console.error('[models] 失效后探测失败:', e.message));
      }
    }).catch((e) => console.error('[models] 已失效的探测失败:', e.message));
    return;
  }
  probeAll().catch((e) => console.error('[models] 失效后探测失败:', e.message));
}

/**
 * 选一个当前可用的账号用于探测
 */
function buildHeaders(auth) {
  return {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    'session_id': randomUUID(),
  };
}

async function sendProbe(modelId, auth, signal) {
  const body = {
    model: modelId,
    instructions: 'probe',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
  };
  const dispatcher = getProxyAgent(auth.proxyUrl);
  return fetch(BACKEND_URL, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: JSON.stringify(body),
    signal,
    dispatcher,
  });
}

async function fetchModelCatalog(auth) {
  const dispatcher = getProxyAgent(auth.proxyUrl);
  const request = () => fetch(MODELS_URL, {
    headers: {
      ...BROWSER_HEADERS,
      'Accept': 'application/json',
      'Authorization': `Bearer ${auth.accessToken}`,
      'chatgpt-account-id': auth.accountId,
    },
    dispatcher,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  let res = await request();
  if ((res.status === 401 || res.status === 403) && auth.accountId) {
    const refreshed = await refreshTokenByAccountId(auth.accountId);
    if (refreshed?.accessToken && refreshed.accessToken !== auth.accessToken) {
      auth.accessToken = refreshed.accessToken;
      res = await request();
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`模型目录获取失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }

  const payload = await res.json();
  return parseModelCatalog(payload);
}

export async function hasModelProbeOutput(stream) {
  if (!stream) return false;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let hasText = false;
  const inspectEvent = (event) => {
    try {
      if (event.type === 'response.output_text.delta' && String(event.delta || '').trim()) {
        hasText = true;
      } else if (event.type === 'response.output_text.done' && String(event.text || '').trim()) {
        hasText = true;
      } else if (event.type === 'response.completed') {
        const outputText = (event.response?.output || [])
          .flatMap((item) => item.content || [])
          .filter((part) => part.type === 'output_text')
          .map((part) => part.text || '')
          .join('');
        if (outputText.trim()) hasText = true;
      }
    } catch {}
  };
  const parseChunk = createSSEParser(inspectEvent);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parseChunk(decoder.decode(value, { stream: true }));
    }
    parseChunk(decoder.decode(), true);
  } finally {
    reader.releaseLock();
  }
  return hasText;
}

/**
 * 探测单个模型 — 发送最小请求体，401/403 时刷新 token 重试一次
 */
async function probeModel(modelId, auth) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

  try {
    let res = await sendProbe(modelId, auth, ctrl.signal);

    // 401/403 → 刷新 token 重试一次（同 proxy.js 逻辑）
    if ((res.status === 401 || res.status === 403) && auth.accountId) {
      try {
        const refreshed = await refreshTokenByAccountId(auth.accountId);
        if (refreshed && refreshed.accessToken && refreshed.accessToken !== auth.accessToken) {
          auth.accessToken = refreshed.accessToken;
          res = await sendProbe(modelId, auth, ctrl.signal);
        }
      } catch (_) {}
    }

    if (res.status === 200) {
      const hasOutput = await hasModelProbeOutput(res.body);
      const latency = Date.now() - start;
      return hasOutput
        ? { available: true, latency }
        : { available: false, latency, reason: 'model_empty_response' };
    }

    const latency = Date.now() - start;
    const text = await res.text().catch(() => '');

    if (res.status === 401 || res.status === 403) {
      // 区分细分原因：token_invalidated（被服务端作废）vs 普通过期
      if (/token_invalidated/.test(text)) {
        return { available: false, latency, reason: 'token_invalidated' };
      }
      return { available: false, latency, reason: 'auth_failed' };
    }

    if (
      res.status === 404 ||
      /model.*not.*(found|support|exist)|invalid.*model|unknown.*model|does not exist/i.test(text)
    ) {
      return { available: false, latency, reason: 'model_not_found', status: res.status };
    }
    return { available: false, latency, reason: `http_${res.status}` };
  } catch (e) {
    return {
      available: false,
      latency: Date.now() - start,
      reason: e.name === 'AbortError' ? 'timeout' : 'network_error',
      error: e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 动态获取并探测模型 — 自动跨账号：账号 token 失效时切下一个
 */
function probeAll() {
  if (probePromise) return probePromise;
  const generation = probeGeneration;
  probePromise = (async () => {
    const auths = loadAccountsForProxy().filter(
      (a) => a.type === 'codex' && a.accessToken && a.accountId
    );
    if (auths.length === 0) {
      if (generation !== probeGeneration) return;
      cache.lastProbed = Date.now();
      cache.results = {};
      modelIds = [];
      catalogError = null;
      return;
    }
    cache.inProgress = true;
    const newResults = {};
    try {
      const catalogByAccount = new Map();
      const discoveredIds = new Set();
      catalogError = null;
      for (const candidate of auths) {
        if (generation !== probeGeneration) return;
        if (isAccountUnavailable(candidate.accountId)) continue;
        const probeAuth = { ...candidate };
        try {
          const ids = await fetchModelCatalog(probeAuth);
          catalogByAccount.set(candidate.accountId, ids);
          ids.forEach((id) => discoveredIds.add(id));
        } catch (e) {
          catalogError = catalogError ? `${catalogError}; ${e.message}` : e.message;
          if (e.status === 401 || e.status === 403) {
            markAccountUnavailable(candidate.accountId);
          }
        }
      }
      if (generation !== probeGeneration) return;
      modelIds = [...discoveredIds];

      for (const modelId of modelIds) {
        if (generation !== probeGeneration) return;
        const accountResults = [];
        for (const candidate of auths) {
          if (generation !== probeGeneration) return;
          if (isAccountUnavailable(candidate.accountId)) continue;
          const ids = catalogByAccount.get(candidate.accountId);
          if (!ids?.includes(modelId)) continue;
          const result = await probeModel(modelId, { ...candidate });
          accountResults.push({
            accountIdMask: `${candidate.accountId.slice(0, 8)}…`,
            available: result.available,
            latency: result.latency,
            reason: result.reason,
          });
          if (result.reason === 'token_invalidated' || result.reason === 'auth_failed') {
            markAccountUnavailable(candidate.accountId);
          }
          await new Promise((res) => setTimeout(res, 100));
        }
        const availableResults = accountResults.filter((r) => r.available);
        const available = availableResults.length > 0;
        const result = available
          ? availableResults.reduce((best, r) => r.latency < best.latency ? r : best)
          : accountResults[0];
        newResults[modelId] = {
          available,
          availableAccountCount: availableResults.length,
          accountCount: accountResults.length,
          latency: result?.latency ?? 0,
          reason: available ? null : (result?.reason || 'no_healthy_account'),
          accountResults,
          probedAt: Date.now(),
        };
      }
      if (generation !== probeGeneration) return;
      cache.results = newResults;
      cache.lastProbed = Date.now();
    } finally {
      cache.inProgress = false;
    }
  })().finally(() => { probePromise = null; });
  return probePromise;
}

/**
 * 强制重新探测（清除缓存并 await 完成）
 */
export async function refreshModels() {
  probeGeneration++;
  clearModelCache();
  const pendingProbe = probePromise;
  if (pendingProbe) await pendingProbe;
  await probeAll();
  return getModelsStatus();
}

/**
 * 后台懒探测：缓存过期且没有进行中，启动一次（fire-and-forget）
 */
function maybeProbeInBackground() {
  if (probePromise) return;
  if (Date.now() - cache.lastProbed < CACHE_TTL_MS) return;
  probeAll().catch((e) => console.error('[models] 探测异常:', e.message));
}

/**
 * 获取 OpenAI 兼容格式的可用模型列表（用于 /v1/models）
 * 缓存为空时后台启动目录发现，不返回猜测的模型 ID
 */
export function getAvailableModelsOpenAI() {
  maybeProbeInBackground();
  const availableIds = modelIds.filter((id) => !cache.results[id] || cache.results[id].available);
  return availableIds.map((id) => ({
    id,
    object: 'model',
    created: 1687882411,
    owned_by: 'openai',
  }));
}

export function getDefaultChatModel() {
  maybeProbeInBackground();
  const availableModel = modelIds.find((id) => cache.results[id]?.available);
  if (availableModel) return availableModel;
  return cache.inProgress || cache.lastProbed === 0 ? modelIds[0] || '' : '';
}

export function getDefaultImageModel() {
  maybeProbeInBackground();
  return modelIds.find((id) => /(?:^|[._-])(?:image|dall-e)(?:[._-]|$)/i.test(id))
    || modelIds.find((id) => /image/i.test(id))
    || '';
}

/**
 * 获取完整的探测状态（用于前端 /api/models 详细页）
 */
export function getModelsStatus() {
  maybeProbeInBackground();
  const models = modelIds.map((id) => ({
    id,
    type: /image/i.test(id) ? 'image' : 'text',
    ...(cache.results[id] || { available: null, latency: null, reason: 'not_probed' }),
  }));
  return {
    lastProbed: cache.lastProbed,
    inProgress: cache.inProgress,
    catalogError,
    models,
  };
}

/**
 * 检查所有账号的 token 健康状态（每账号一次最小探测）
 * 返回：[{ accountId, healthy, reason, latency }]
 */
export async function checkAllAccountsHealth() {
  const auths = loadAccountsForProxy();
  const out = [];
  for (const auth of auths) {
    if (auth.type !== 'codex' || !auth.accessToken || !auth.accountId) {
      out.push({ accountId: auth.accountId, healthy: false, reason: 'no_token', latency: 0 });
      continue;
    }
    let r;
    try {
      const ids = await fetchModelCatalog(auth);
      r = ids.length ? await probeModel(ids[0], { ...auth }) : { available: true, latency: 0 };
    } catch (e) {
      r = { available: false, latency: 0, reason: e.message };
    }
    out.push({
      accountId: auth.accountId,
      healthy: r.available,
      reason: r.reason || null,
      latency: r.latency,
    });
    await new Promise((res) => setTimeout(res, 150));
  }
  return out;
}

/**
 * 服务启动时触发初次探测（如有账号）
 */
export function initialProbe() {
  // 延迟 3 秒启动，等待账号加载完成
  setTimeout(() => {
    if (loadAccountsForProxy().length > 0) {
      probeAll().catch((e) => console.error('[models] 初始探测失败:', e.message));
    }
  }, 3000);
}
