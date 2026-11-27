/**
 * 提供商转发：把内部 OpenAI Chat Completions 请求，按提供商类型转发并翻译。
 *   - openai    : 直接透传到 <base>/chat/completions（含流式原样透传）
 *   - anthropic : OpenAI 格式 <-> Anthropic /v1/messages 互转（含流式 SSE 翻译）
 *   - google    : OpenAI 格式 <-> Gemini generateContent 互转（含流式 SSE 翻译）
 * 约定：调用方传入的 body.model 已去掉“提供商名/”前缀。
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { providerKeys, parseKeys } from './providers.js';
import { createSSEParser } from './sse.js';

const ANTHROPIC_VERSION = '2023-06-01';

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function openaiChatUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
  if (/\/v1\//i.test(b)) return `${b.replace(/\/+$/, '')}/chat/completions`; // 如 .../api/v1
  return `${b}/v1/chat/completions`;
}

function anthropicMessagesUrl(baseUrl) {
  const b = baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return `${b}/v1/messages`;
}

function googleEndpoint(baseUrl, model, stream) {
  const b = baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/i, '');
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return `${b}/v1beta/models/${encodeURIComponent(model)}:${method}`;
}

// ── 文本抽取（兼容 string / parts 数组）──
function toText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      .join('');
  }
  return '';
}

function splitSystem(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages || []) {
    if (m.role === 'system' || m.role === 'developer') sys.push(toText(m.content));
    else rest.push(m);
  }
  return { system: sys.filter(Boolean).join('\n\n'), messages: rest };
}

// ── OpenAI -> Anthropic ──
export function openaiToAnthropic(body) {
  const { system, messages } = splitSystem(body.messages || []);
  const out = {
    model: body.model,
    max_tokens: Number(body.max_tokens) > 0 ? Number(body.max_tokens) : 4096,
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: toText(m.content),
    })),
  };
  if (system) out.system = system;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  return out;
}

// ── Anthropic -> OpenAI（非流式）──
export function anthropicToOpenai(json, model) {
  const text = (json.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join('');
  const usage = {
    prompt_tokens: json.usage?.input_tokens || 0,
    completion_tokens: json.usage?.output_tokens || 0,
    total_tokens: (json.usage?.input_tokens || 0) + (json.usage?.output_tokens || 0),
  };
  return {
    id: `chatcmpl-${(json.id || randomUUID()).replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null }, finish_reason: mapAnthropicStop(json.stop_reason) }],
    usage,
  };
}
function mapAnthropicStop(r) {
  if (r === 'max_tokens') return 'length';
  if (r === 'tool_use') return 'tool_calls';
  return 'stop';
}

// ── OpenAI -> Google ──
export function openaiToGoogle(body) {
  const { system, messages } = splitSystem(body.messages || []);
  const out = {
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: toText(m.content) }],
    })),
  };
  if (system) out.systemInstruction = { parts: [{ text: system }] };
  const gen = {};
  if (typeof body.temperature === 'number') gen.temperature = body.temperature;
  if (body.top_p != null) gen.top_p = body.top_p;
  if (Number(body.max_tokens) > 0) gen.maxOutputTokens = Number(body.max_tokens);
  if (Object.keys(gen).length) out.generationConfig = gen;
  return out;
}

// ── Google -> OpenAI（非流式）──
export function googleToOpenai(json, model) {
  const text = (json.candidates || [])
    .flatMap((c) => (c.content?.parts || []).map((p) => p.text || ''))
    .join('');
  const meta = json.usageMetadata || {};
  const usage = {
    prompt_tokens: meta.promptTokenCount || 0,
    completion_tokens: meta.candidatesTokenCount || 0,
    total_tokens: meta.totalTokenCount || 0,
  };
  const fr = (json.candidates?.[0]?.finishReason || '').toLowerCase();
  return {
    id: `chatcmpl-${randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null }, finish_reason: fr === 'max_tokens' ? 'length' : 'stop' }],
    usage,
  };
}

// ── SSE 行解析：产出每个 data: 的 JSON 对象 ──
async function* sseJsonObjects(webBody) {
  const reader = webBody.getReader();
  const dec = new TextDecoder();
  const events = [];
  const parse = createSSEParser(event => {
    if (event && event.type !== '[DONE]' && typeof event.data !== 'string') events.push(event);
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parse(dec.decode(value, { stream: true }));
      yield* events;
      events.length = 0;
    }
    parse(dec.decode(), true);
    yield* events;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function chunk(id, model, delta, finish) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
  };
}
function writeSSE(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

function sseStart(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function proxyError(res, status, message) {
  if (res.headersSent) { res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`); res.end(); return; }
  res.status(status).json({ error: { message, type: 'provider_error' } });
}

// ── 多 Key 轮询（同一提供商填多个 api key 时自动轮换）──
const rrCursors = new Map();

/**
 * 本次请求的 Key 尝试顺序：从轮询游标当前位开始遍历全部 Key。
 * 效果：每次请求换一个 Key（round-robin，分摊限额）；若某 Key 报鉴权/限额类错误，可顺着往后重试其它 Key。
 */
function orderedKeys(provider) {
  const keys = providerKeys(provider);
  if (keys.length <= 1) return keys;
  const id = provider.id || provider.name || '';
  const start = (rrCursors.get(id) || 0) % keys.length;
  rrCursors.set(id, (start + 1) % keys.length);
  return keys.slice(start).concat(keys.slice(0, start));
}

/** 按提供商类型构造上游请求（Key 只影响鉴权头） */
function prepareUpstream(provider, key, body, stream) {
  if (provider.type === 'openai') {
    return {
      url: openaiChatUrl(provider.base_url),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      payload: JSON.stringify({ ...body, model: body.model }),
    };
  }
  if (provider.type === 'anthropic') {
    return {
      url: anthropicMessagesUrl(provider.base_url),
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
      payload: JSON.stringify(openaiToAnthropic(body)),
    };
  }
  if (provider.type === 'google') {
    return {
      url: googleEndpoint(provider.base_url, body.model, stream),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      payload: JSON.stringify(openaiToGoogle(body)),
    };
  }
  return null;
}

function sendProviderJson(res, body) {
  if (res.locals && body.usage) res.locals.gatewayUsage = body.usage;
  res.json(body);
}

async function respondOpenai(upstream, res, stream) {
  if (stream) {
    sseStart(res);
    const streamBody = Readable.fromWeb(upstream.body);
    if (res.locals) {
      const decoder = new StringDecoder('utf8');
      const parse = createSSEParser(event => {
        if (event?.usage) res.locals.gatewayUsage = event.usage;
      });
      streamBody.on('data', bytes => parse(decoder.write(bytes)));
      streamBody.on('end', () => parse(decoder.end(), true));
    }
    streamBody.pipe(res);
    return;
  }
  sendProviderJson(res, await upstream.json());
}

async function respondAnthropic(upstream, res, stream, model, id) {
  if (stream) {
    sseStart(res);
    writeSSE(res, chunk(id, model, { role: 'assistant' }));
    const usage = {};
    for await (const ev of sseJsonObjects(upstream.body)) {
      if (ev.type === 'message_start') usage.prompt_tokens = ev.message?.usage?.input_tokens;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        writeSSE(res, chunk(id, model, { content: ev.delta.text }));
      } else if (ev.type === 'message_delta') {
        usage.completion_tokens = ev.usage?.output_tokens ?? usage.completion_tokens;
        writeSSE(res, chunk(id, model, {}, mapAnthropicStop(ev.delta?.stop_reason)));
      }
    }
    if (res.locals) res.locals.gatewayUsage = usage;
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }
  sendProviderJson(res, anthropicToOpenai(await upstream.json(), model));
}

async function respondGoogle(upstream, res, stream, model, id) {
  if (stream) {
    sseStart(res);
    writeSSE(res, chunk(id, model, { role: 'assistant' }));
    for await (const ev of sseJsonObjects(upstream.body)) {
      if (ev.usageMetadata && res.locals) {
        res.locals.gatewayUsage = {
          prompt_tokens: ev.usageMetadata.promptTokenCount,
          completion_tokens: ev.usageMetadata.candidatesTokenCount,
        };
      }
      const text = (ev.candidates || []).flatMap((c) => (c.content?.parts || []).map((p) => p.text || '')).join('');
      if (text) writeSSE(res, chunk(id, model, { content: text }));
      const fr = (ev.candidates?.[0]?.finishReason || '').toLowerCase();
      if (fr) writeSSE(res, chunk(id, model, {}, fr === 'max_tokens' ? 'length' : 'stop'));
    }
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }
  sendProviderJson(res, googleToOpenai(await upstream.json(), model));
}

// 换 Key 重试有意义（Key 自身被拒/超额）的状态码
const KEY_RETRY_STATUS = new Set([401, 403, 429]);

/**
 * 主入口：转发一次 chat/completions。body.model 已去前缀；多 Key 时自动轮询并在 Key 级错误时切换重试。
 */
export async function forwardChatCompletion(provider, body, res, { signal } = {}) {
  const model = body.model;
  const stream = body.stream === true;
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

  const keys = orderedKeys(provider);
  const attempts = keys.length ? keys : [''];

  for (let i = 0; i < attempts.length; i++) {
    const req = prepareUpstream(provider, attempts[i], body, stream);
    if (!req) return proxyError(res, 400, `未知提供商类型：${provider.type}`);

    let upstream;
    try {
      upstream = await fetch(req.url, { method: 'POST', headers: req.headers, body: req.payload, signal });
    } catch (e) {
      return proxyError(res, 502, `转发失败：${e.message}`);
    }

    if (upstream.ok) {
      try {
        if (provider.type === 'anthropic') return await respondAnthropic(upstream, res, stream, model, id);
        if (provider.type === 'google') return await respondGoogle(upstream, res, stream, model, id);
        return await respondOpenai(upstream, res, stream);
      } catch (e) {
        return proxyError(res, 502, `转发失败：${e.message}`);
      }
    }

    const t = await upstream.text().catch(() => '');
    if (KEY_RETRY_STATUS.has(upstream.status) && i < attempts.length - 1) continue; // 换下一个 Key
    return proxyError(res, upstream.status, `上游(${provider.type}) ${upstream.status}: ${t.slice(0, 400)}`);
  }
  return proxyError(res, 502, '转发失败：无可用 Key');
}

/**
 * 一键获取上游真实模型列表（可用于新增/编辑时，未保存也能测）。返回模型 id 字符串数组。
 * 填了多个 Key 时逐个试（某个 Key 无权限/超额则换下一个）。
 */
export async function fetchProviderModels({ type, base_url, api_key, api_keys } = {}, { signal } = {}) {
  if (!base_url) throw new Error('base_url 不能为空');
  const b = String(base_url).replace(/\/+$/, '');
  let url, headers, parse;
  if (type === 'anthropic') {
    url = `${b.replace(/\/v1$/i, '')}/v1/models`;
    headers = (k) => ({ 'x-api-key': k, 'anthropic-version': ANTHROPIC_VERSION });
    parse = (j) => (j.data || []).map((m) => m.id).filter(Boolean);
  } else if (type === 'google') {
    url = `${b.replace(/\/v1beta$/i, '')}/v1beta/models`;
    headers = (k) => ({ 'x-goog-api-key': k });
    parse = (j) => (j.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
  } else {
    url = /\/v1$/i.test(b) ? `${b}/models` : `${b}/v1/models`;
    headers = (k) => ({ Authorization: `Bearer ${k}` });
    parse = (j) => (j.data || []).map((m) => m.id).filter(Boolean);
  }
  const keys = parseKeys({ api_keys, api_key });
  const attempts = keys.length ? keys : [''];
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const res = await fetch(url, { headers: headers(attempts[i]), signal });
    const text = await res.text();
    if (res.ok) {
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { throw new Error('上游返回非 JSON'); }
      return parse(json);
    }
    lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    lastErr.status = res.status;
    if (!KEY_RETRY_STATUS.has(res.status) || i === attempts.length - 1) break; // 非 Key 问题或已试完
  }
  throw lastErr || new Error('获取失败');
}
