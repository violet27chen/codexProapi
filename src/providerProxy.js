/**
 * 提供商转发：把内部 OpenAI Chat Completions 请求，按提供商类型转发并翻译。
 *   - openai    : 直接透传到 <base>/chat/completions（含流式原样透传）
 *   - anthropic : OpenAI 格式 <-> Anthropic /v1/messages 互转（含流式 SSE 翻译）
 *   - google    : OpenAI 格式 <-> Gemini generateContent 互转（含流式 SSE 翻译）
 * 约定：调用方传入的 body.model 已去掉“提供商名/”前缀。
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

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
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { yield JSON.parse(payload); } catch { /* 忽略非 JSON 行 */ }
        }
      }
    }
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

/**
 * 主入口：转发一次 chat/completions。body.model 已去前缀。
 */
export async function forwardChatCompletion(provider, body, res) {
  const model = body.model;
  const stream = body.stream === true;
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

  try {
    if (provider.type === 'openai') {
      const url = openaiChatUrl(provider.base_url);
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key}` },
        body: JSON.stringify({ ...body, model }),
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return proxyError(res, upstream.status, `上游(openai) ${upstream.status}: ${t.slice(0, 400)}`);
      }
      if (stream) {
        sseStart(res);
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }
      const json = await upstream.json();
      res.json(json);
      return;
    }

    if (provider.type === 'anthropic') {
      const url = anthropicMessagesUrl(provider.base_url);
      const aBody = openaiToAnthropic({ ...body, model });
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': provider.api_key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(aBody),
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return proxyError(res, upstream.status, `上游(anthropic) ${upstream.status}: ${t.slice(0, 400)}`);
      }
      if (stream) {
        sseStart(res);
        writeSSE(res, chunk(id, model, { role: 'assistant' }));
        for await (const ev of sseJsonObjects(upstream.body)) {
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            writeSSE(res, chunk(id, model, { content: ev.delta.text }));
          } else if (ev.type === 'message_delta') {
            const fr = mapAnthropicStop(ev.delta?.stop_reason);
            writeSSE(res, chunk(id, model, {}, fr));
          }
        }
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }
      const json = await upstream.json();
      res.json(anthropicToOpenai(json, model));
      return;
    }

    if (provider.type === 'google') {
      const url = googleEndpoint(provider.base_url, model, stream);
      const gBody = openaiToGoogle({ ...body, model });
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': provider.api_key },
        body: JSON.stringify(gBody),
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return proxyError(res, upstream.status, `上游(google) ${upstream.status}: ${t.slice(0, 400)}`);
      }
      if (stream) {
        sseStart(res);
        writeSSE(res, chunk(id, model, { role: 'assistant' }));
        for await (const ev of sseJsonObjects(upstream.body)) {
          const text = (ev.candidates || []).flatMap((c) => (c.content?.parts || []).map((p) => p.text || '')).join('');
          if (text) writeSSE(res, chunk(id, model, { content: text }));
          const fr = (ev.candidates?.[0]?.finishReason || '').toLowerCase();
          if (fr) writeSSE(res, chunk(id, model, {}, fr === 'max_tokens' ? 'length' : 'stop'));
        }
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }
      const json = await upstream.json();
      res.json(googleToOpenai(json, model));
      return;
    }

    return proxyError(res, 400, `未知提供商类型：${provider.type}`);
  } catch (e) {
    return proxyError(res, 502, `转发失败：${e.message}`);
  }
}
