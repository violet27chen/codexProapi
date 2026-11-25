import { randomUUID } from 'crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import { loadAuth } from './auth.js';
import { markAccountUnavailable } from './accountStatus.js';
import { recordUsage, clearUsage } from './usageTracker.js';
import { createSSEParser } from './sse.js';
import { refreshTokenByAccountId, isTokenExpiringSoon } from './tokenRefresh.js';
import { getProxyAgent } from './proxyAgent.js';

const BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';

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

function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 88 && c === 99 || b === 0 && (c === 0 || c === 2)))
      || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100))
      || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return false;
    const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return firstHextet >= 0x2000 && firstHextet <= 0x3fff
      && !normalized.startsWith('2001:db8:')
      && !normalized.startsWith('2001:10:');
  }
  return false;
}

async function assertPublicImageUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('图片 URL 必须是无凭据的 HTTP(S) 公网地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('不允许读取本机或局域网图片地址');
  }
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('图片 URL 必须解析到公网 IP');
  }
  return { url, address: addresses[0] };
}

async function downloadExternalImage(rawUrl, proxyUrl) {
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  let url = rawUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (proxyUrl) throw new Error('配置账号代理时不支持外部图片 URL；请改用图片 URL 或 Base64 data URL');
    const validated = await assertPublicImageUrl(url);
    url = validated.url;
    const { address, family } = validated.address;
    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
    });
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        dispatcher,
        redirect: 'manual',
      });
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      await dispatcher.close();
      if (!location || redirects === 3) throw new Error('图片 URL 重定向次数过多或缺少目标地址');
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      await dispatcher.close();
      throw new Error(`下载图片失败 (${response.status})`);
    }
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!mime.startsWith('image/')) {
      await response.body?.cancel();
      await dispatcher.close();
      throw new Error('图片 URL 返回的内容不是图片');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel();
      await dispatcher.close();
      throw new Error('图片文件超过 20 MB 限制');
    }
    const reader = response.body?.getReader();
    if (!reader) {
      await dispatcher.close();
      throw new Error('图片响应为空');
    }
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error('图片文件超过 20 MB 限制');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      await dispatcher.close();
    }
    return `data:${mime};base64,${Buffer.concat(chunks, total).toString('base64')}`;
  }
  throw new Error('图片 URL 重定向次数过多');
}

async function getMessageContentParts(msg, proxyUrl) {
  const content = [];
  const raw = msg.content;
  if (typeof raw === 'string') {
    if (raw.trim()) content.push({ type: 'text', text: raw });
  } else if (Array.isArray(raw)) {
    for (const c of raw) {
      if (c == null) continue;
      if (typeof c === 'string') {
        if (c.trim()) content.push({ type: 'text', text: c });
        continue;
      }
      if (typeof c !== 'object') continue;
      if (c.type === 'image_url' || c.image_url) {
        let url = typeof c.image_url === 'string' ? c.image_url : (c.image_url?.url || '');
        const detail = c.image_url?.detail || 'auto';
        if (!url) continue;
        // 外部 URL 下载转 base64（Codex 不支持外部 HTTP URL）
        if (/^https?:\/\//i.test(url)) {
          url = await downloadExternalImage(url, proxyUrl);
        }
        if (url) content.push({ type: 'image_url', url, detail });
      } else if (c.type === 'text' || c.text != null) {
        const text = String(c.text ?? '').trim();
        if (text) content.push({ type: 'text', text });
      }
    }
  } else {
    const text = String(raw ?? '').trim();
    if (text) content.push({ type: 'text', text });
  }
  return content;
}

export async function messagesToInput(messages, proxyUrl) {
  const input = [];
  const textLines = [];
  const pendingImages = [];
  const flushText = () => {
    const content = [];
    const fullText = textLines.join('\n').trim();
    if (fullText) content.push({ type: 'input_text', text: fullText });
    content.push(...pendingImages.splice(0));
    if (content.length) input.push({ type: 'message', role: 'user', content });
    textLines.length = 0;
  };

  for (const msg of messages) {
    const role = String(msg.role || 'user').toLowerCase();
    if (role === 'tool') {
      flushText();
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
      });
      continue;
    }

    const contentParts = await getMessageContentParts(msg, proxyUrl);
    const texts = contentParts.filter((p) => p.type === 'text').map((p) => p.text);
    const imageParts = contentParts.filter((p) => p.type === 'image_url');

    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      if (texts.length) textLines.push(`Assistant: ${texts.join(' ')}`);
      flushText();
      for (const toolCall of msg.tool_calls) {
        const fn = toolCall.function || {};
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: fn.name || '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
        });
      }
      continue;
    }
    if (contentParts.length === 0) continue;

    if (role === 'assistant') {
      textLines.push(`Assistant: ${texts.join(' ')}`);
      continue;
    }
    if (role === 'system') {
      textLines.push(`System: ${texts.join(' ')}`);
      continue;
    }
    // user
    if (textLines.length) textLines.push('');
    textLines.push(`User: ${texts.join(' ')}`);
    for (const img of imageParts) {
      pendingImages.push({ type: 'input_image', image_url: img.url, detail: img.detail || 'auto' });
    }
  }

  flushText();
  return input;
}

/** 官方标准：约 4 字符 = 1 token，用于估算 prompt_tokens */
async function estimatePromptTokens(openaiReq) {
  let chars = 0;
  const messages = openaiReq.messages || [];
  for (const msg of messages) {
    const parts = await getMessageContentParts(msg);
    for (const p of parts) {
      if (p.type === 'text' && p.text) chars += String(p.text).length;
    }
  }
  const tools = openaiReq.tools;
  if (Array.isArray(tools)) {
    chars += JSON.stringify(tools).length;
  }
  return Math.max(0, Math.ceil(chars / 4));
}

/**
 * 构建发往 ChatGPT Codex 后端的请求体
 * 后端强制要求 stream 为 true，故始终传 true；是否向客户端流式由 handleChatCompletions 根据 openaiReq.stream 决定。
 * tools/tool_choice：无 tools 时传空数组且 tool_choice 为 'none'，避免后端报 Missing required parameter。
 */
/**
 * 规范化工具格式：将 OpenAI Chat Completions 旧格式 (function.name) 转为 Codex Responses 格式 (name)
 */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(t => {
    if (!t || typeof t !== 'object') return t;
    if (t.name) return t;
    if (t.function && typeof t.function === 'object') {
      const f = t.function;
      const out = { type: t.type || 'function' };
      if (f.name) out.name = f.name;
      if (f.description) out.description = f.description;
      if (f.parameters) out.parameters = f.parameters;
      return out;
    }
    return t;
  });
}

export function normalizeClaudeMessagesRequest(body) {
  const source = body && typeof body === 'object' ? body : {};
  const messages = [];

  if (typeof source.system === 'string' && source.system.trim()) {
    messages.push({ role: 'system', content: source.system });
  } else if (Array.isArray(source.system)) {
    const systemText = source.system
      .filter((part) => part && (part.type === 'text' || typeof part.text === 'string'))
      .map((part) => String(part.text || '').trim())
      .filter(Boolean)
      .join('\n');
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  if (Array.isArray(source.messages)) {
    for (const message of source.messages) {
      if (!message || typeof message !== 'object') continue;
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      if (typeof message.content === 'string') {
        if (message.content.trim()) messages.push({ role, content: message.content });
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const content = [];
      for (const part of message.content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image') {
          const sourceInfo = part.source;
          if (sourceInfo?.type === 'base64' && sourceInfo.media_type && sourceInfo.data) {
            content.push({
              type: 'image_url',
              image_url: { url: `data:${sourceInfo.media_type};base64,${sourceInfo.data}`, detail: 'auto' },
            });
          } else if (sourceInfo?.type === 'url' && sourceInfo.url) {
            content.push({ type: 'image_url', image_url: { url: sourceInfo.url, detail: 'auto' } });
          }
        } else if (part.type === 'tool_result') {
          content.push({ type: 'text', text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content ?? '') });
        } else if (part.type === 'tool_use') {
          content.push({ type: 'text', text: `${part.name || 'tool'}(${JSON.stringify(part.input || {})})` });
        }
      }
      if (content.length) messages.push({ role, content });
    }
  }

  return {
    model: typeof source.model === 'string' ? source.model : '',
    messages,
    stream: source.stream === true,
  };
}

export function normalizeOpenAIResponsesRequest(body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const messages = [];
  if (typeof source.instructions === 'string' && source.instructions.trim()) {
    messages.push({ role: 'system', content: source.instructions });
  }

  const addMessage = (role, content) => {
    const normalizedRole = role === 'assistant' ? 'assistant' : role === 'system' || role === 'developer' ? 'system' : 'user';
    if (typeof content === 'string' && content.trim()) {
      messages.push({ role: normalizedRole, content });
      return;
    }
    if (!Array.isArray(content)) return;
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'input_image') {
        const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (imageUrl) {
          parts.push({
            type: 'image_url',
            image_url: { url: imageUrl, detail: part.detail || 'auto' },
          });
        }
      }
    }
    if (parts.length) messages.push({ role: normalizedRole, content: parts });
  };

  if (typeof source.input === 'string') {
    addMessage('user', source.input);
  } else if (Array.isArray(source.input)) {
    for (const item of source.input) {
      if (typeof item === 'string') {
        addMessage('user', item);
      } else if (item && typeof item === 'object' && (item.type === 'message' || item.role)) {
        addMessage(item.role || 'user', item.content);
      } else if (item?.type === 'function_call') {
        messages.push({ role: 'assistant', content: null, tool_calls: [{
          id: item.call_id || item.id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments || '{}' },
        }] });
      } else if (item?.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output ?? '' });
      } else {
        throw new Error('Responses API 的 input 仅支持文本/图片消息');
      }
    }
  } else {
    throw new Error('Responses API 请求必须包含 string 或 array 类型的 input');
  }

  const tools = Array.isArray(source.tools) ? source.tools : [];
  if (tools.some((tool) => tool?.type !== 'function' || !tool.name)) {
    throw new Error('Responses API 目前仅支持 function 类型工具');
  }
  return {
    model: typeof source.model === 'string' ? source.model : '',
    messages,
    stream: source.stream === true,
    tools,
    tool_choice: source.tool_choice,
    parallel_tool_calls: source.parallel_tool_calls === true,
  };
}

async function buildResponsesRequest(openaiReq, proxyUrl) {
  const tools = normalizeTools(openaiReq.tools || []);
  const rawToolChoice = openaiReq.tool_choice;
  let tool_choice;
  if (tools.length === 0) {
    tool_choice = 'none';
  } else if (rawToolChoice === 'none' || rawToolChoice === 'auto' || rawToolChoice === 'required') {
    tool_choice = rawToolChoice;
  } else if (rawToolChoice && typeof rawToolChoice === 'object' && rawToolChoice.type) {
    tool_choice = rawToolChoice;
  } else {
    tool_choice = 'auto';
  }
  return {
    model: openaiReq.model,
    instructions: 'You are a helpful AI assistant. Provide clear, accurate, and concise responses.',
    input: await messagesToInput(openaiReq.messages || [], proxyUrl),
    tools,
    tool_choice,
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
  };
}

/**
 * 非流式：从 SSE 响应中收集完整文本后返回
 */
function extractCompletedOutputText(event) {
  if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
    return event.text;
  }
  const output = event.type === 'response.output_item.done'
    ? [event.item]
    : event.type === 'response.completed'
      ? event.response?.output
      : [];
  return (output || [])
    .flatMap((item) => item?.content || [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function createFunctionCallCollector() {
  const calls = new Map();
  const normalizeArguments = (argumentsText) => {
    try {
      const args = JSON.parse(argumentsText);
      if (args && typeof args === 'object' && !Array.isArray(args)
        && typeof args.cd === 'string' && !args.cd.trim()) {
        delete args.cd;
        return JSON.stringify(args);
      }
    } catch {}
    return argumentsText;
  };
  const getCall = (item = {}, index) => {
    const key = String(index ?? item.id ?? item.call_id ?? calls.size);
    if (!calls.has(key)) {
      calls.set(key, {
        index: Number.isFinite(Number(index)) ? Number(index) : calls.size,
        id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: '',
      });
    }
    const call = calls.get(key);
    if (item.call_id) call.id = item.call_id;
    if (item.id && !call.id) call.id = item.id;
    if (item.name) call.name = item.name;
    if (typeof item.arguments === 'string' && item.arguments) call.arguments = item.arguments;
    return call;
  };

  const collectItem = (item, index) => {
    if (item?.type !== 'function_call') return;
    getCall(item, index);
  };

  return {
    add(event) {
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        collectItem(event.item, event.output_index);
      } else if (event.type === 'response.function_call_arguments.delta') {
        const call = getCall({}, event.output_index);
        call.arguments += String(event.delta || '');
      } else if (event.type === 'response.function_call_arguments.done') {
        const call = getCall({}, event.output_index);
        if (typeof event.arguments === 'string') call.arguments = event.arguments;
      } else if (event.type === 'response.completed') {
        for (const [index, item] of (event.response?.output || []).entries()) {
          collectItem(item, index);
        }
      }
    },
    getCalls() {
      return [...calls.values()]
        .sort((a, b) => a.index - b.index)
        .map((call) => ({
          id: call.id || `call_${randomUUID().replace(/-/g, '')}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: normalizeArguments(call.arguments || '{}'),
          },
        }));
    },
  };
}

export async function parseStreamToCompletion(stream) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let fullText = '';
  const functionCalls = createFunctionCallCollector();
  const parseEvent = (event) => {
    functionCalls.add(event);
    if (event.type === 'response.output_text.delta' && event.delta) {
      fullText += event.delta;
    } else if (!fullText) {
      fullText = extractCompletedOutputText(event);
    }
  };
  const parseChunk = createSSEParser(parseEvent);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parseChunk(dec.decode(value, { stream: true }));
  }
  parseChunk(dec.decode(), true);
  const toolCalls = functionCalls.getCalls();
  if (!fullText.trim() && toolCalls.length === 0) {
    const error = new Error('model returned a completed response with no content');
    error.code = 'EMPTY_MODEL_RESPONSE';
    throw error;
  }
  return { text: fullText, toolCalls };
}

export async function parseStreamToText(stream) {
  return (await parseStreamToCompletion(stream)).text;
}

/**
 * 流式：将后端 SSE 转为 OpenAI Chat Completions SSE 格式并写入 res
 * @param {object} [opts] - { onFinish(completionChars) } 流结束时回调，用于用量统计
 */
export function pipeStreamToOpenAI(backendStream, res, model, id, opts = {}) {
  const dec = new TextDecoder();
  let hasSentRole = false;
  let completionChars = 0;
  let doneReceived = false;
  const functionCalls = createFunctionCallCollector();
  const onFinish = opts.onFinish || (() => {});
  const sendChunk = (obj) => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const sendDelta = (delta, finishReason = null) => {
    const choice = { index: 0, delta, finish_reason: finishReason };
    sendChunk({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [choice],
    });
  };
  const sendTextIfMissing = (text) => {
    if (completionChars || !String(text || '').trim()) return;
    completionChars = String(text).length;
    sendDelta({ role: 'assistant' });
    hasSentRole = true;
    sendDelta({ content: text });
  };
  const reader = backendStream.getReader();
  return (async () => {
    try {
      const parseEvent = (event) => {
        functionCalls.add(event);
        if (event.type === '[DONE]') {
          const toolCalls = functionCalls.getCalls();
          if (!completionChars && toolCalls.length === 0) {
            const error = new Error('model returned a completed response with no content');
            error.code = 'EMPTY_MODEL_RESPONSE';
            throw error;
          }
          const toolChars = toolCalls.reduce((sum, call) => sum + call.function.arguments.length, 0);
          onFinish(completionChars + toolChars);
          if (toolCalls.length) {
            sendDelta({
              ...(!hasSentRole ? { role: 'assistant' } : {}),
              tool_calls: toolCalls.map((call, index) => ({ ...call, index })),
            }, 'tool_calls');
            hasSentRole = true;
          } else {
            sendDelta({}, 'stop');
          }
          res.write('data: [DONE]\n\n');
          doneReceived = true;
          return;
        }
        if (event.type === 'response.output_text.delta' && event.delta) {
          completionChars += String(event.delta).length;
          if (!hasSentRole) {
            sendDelta({ role: 'assistant' });
            hasSentRole = true;
          }
          sendDelta({ content: event.delta });
        } else if (!completionChars) {
          sendTextIfMissing(extractCompletedOutputText(event));
        }
      };
      const parseChunk = createSSEParser(parseEvent);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parseChunk(dec.decode(value, { stream: true }));
        if (doneReceived) return;
      }
      parseChunk(dec.decode(), true);
      if (doneReceived) return;
      const toolCalls = functionCalls.getCalls();
      if (!completionChars && toolCalls.length === 0) {
        const error = new Error('model returned a completed response with no content');
        error.code = 'EMPTY_MODEL_RESPONSE';
        throw error;
      }
      const toolChars = toolCalls.reduce((sum, call) => sum + call.function.arguments.length, 0);
      onFinish(completionChars + toolChars);
      if (toolCalls.length) {
        sendDelta({
          ...(!hasSentRole ? { role: 'assistant' } : {}),
          tool_calls: toolCalls.map((call, index) => ({ ...call, index })),
        }, 'tool_calls');
        hasSentRole = true;
      } else {
        sendDelta({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
    } catch (e) {
      if (e.code === 'EMPTY_MODEL_RESPONSE' && !hasSentRole) throw e;
      onFinish(completionChars);
      sendDelta({ content: `\n[Error: ${e.message}]` }, 'stop');
      res.write('data: [DONE]\n\n');
    } finally {
      if (res.headersSent || hasSentRole) res.end();
    }
  })();
}

export function formatOpenAIResponsesResult({
  id,
  messageId,
  model,
  text,
  createdAt,
  promptTokens,
  completionTokens,
  toolCalls = [],
  tools = [],
  toolChoice = 'auto',
  parallelToolCalls = false,
  status = 'completed',
}) {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [
      ...(text ? [{ id: messageId, type: 'message', status, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }] : []),
      ...toolCalls.map((call) => ({
        id: `fc_${call.id}`,
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    ],
    parallel_tool_calls: parallelToolCalls,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: toolChoice,
    tools,
    top_p: 1,
    truncation: 'disabled',
    usage: {
      input_tokens: promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export async function pipeStreamToResponses(backendStream, res, model, opts = {}) {
  const responseId = `resp_${randomUUID().replace(/-/g, '')}`;
  const messageId = `msg_${randomUUID().replace(/-/g, '')}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const dec = new TextDecoder();
  let text = '';
  let finished = false;
  let started = false;
  const functionCalls = createFunctionCallCollector();
  const emit = (event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const start = (includeMessage = true) => {
    if (started) return;
    started = true;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    emit({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model,
        output: [],
      },
    });
    emit({
      type: 'response.in_progress',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model,
        output: [],
      },
    });
    if (!includeMessage) return;
    emit({ type: 'response.output_item.added', output_index: 0, item: item('in_progress', '') });
    emit({
      type: 'response.content_part.added',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };
  const item = (status, contentText = text) => ({
    id: messageId,
    type: 'message',
    status,
    role: 'assistant',
    content: status === 'in_progress' ? [] : [{ type: 'output_text', text: contentText, annotations: [] }],
  });
  const complete = () => {
    if (finished) return;
    const toolCalls = functionCalls.getCalls();
    if (!text.trim() && toolCalls.length === 0) {
      const error = new Error('model returned a completed response with no content');
      error.code = 'EMPTY_MODEL_RESPONSE';
      throw error;
    }
    finished = true;
    start(text.length > 0);
    const completionChars = text.length + toolCalls.reduce((sum, call) => sum + call.function.arguments.length, 0);
    const completionTokens = Math.ceil(completionChars / 4);
    opts.onFinish?.(completionChars);
    if (text) emit({
      type: 'response.output_text.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
    });
    if (text) emit({
      type: 'response.content_part.done',
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    if (text) emit({ type: 'response.output_item.done', output_index: 0, item: item('completed') });
    let outputIndex = text ? 1 : 0;
    for (const call of toolCalls) {
      const functionItem = { id: `fc_${call.id}`, type: 'function_call', status: 'completed', call_id: call.id, name: call.function.name, arguments: call.function.arguments };
      emit({ type: 'response.output_item.added', output_index: outputIndex, item: { ...functionItem, status: 'in_progress', arguments: '' } });
      if (call.function.arguments) emit({ type: 'response.function_call_arguments.delta', item_id: functionItem.id, output_index: outputIndex, delta: call.function.arguments });
      emit({ type: 'response.function_call_arguments.done', item_id: functionItem.id, output_index: outputIndex, arguments: call.function.arguments });
      emit({ type: 'response.output_item.done', output_index: outputIndex, item: functionItem });
      outputIndex++;
    }
    emit({
      type: 'response.completed',
      response: formatOpenAIResponsesResult({
        id: responseId,
        messageId,
        model,
        text,
        createdAt,
        promptTokens: opts.promptTokens || 0,
        completionTokens,
        toolCalls,
        tools: opts.tools || [],
        toolChoice: opts.toolChoice ?? 'auto',
        parallelToolCalls: false,
      }),
    });
  };

  const reader = backendStream.getReader();
  try {
    const parseEvent = (event) => {
      functionCalls.add(event);
      if (event.type === '[DONE]') {
        complete();
        return;
      }
      if (event.type === 'response.output_text.delta' && event.delta) {
        const delta = String(event.delta);
        start();
        text += delta;
        emit({
          type: 'response.output_text.delta',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta,
        });
      } else if (!text) {
        const completedText = extractCompletedOutputText(event);
        if (completedText.trim()) {
          start();
          text = completedText;
          emit({
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: completedText,
          });
        }
      }
    };
    const parseChunk = createSSEParser(parseEvent);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parseChunk(dec.decode(value, { stream: true }));
    }
    parseChunk(dec.decode(), true);
    if (!finished) complete();
  } catch (error) {
    if (error.code === 'EMPTY_MODEL_RESPONSE' && !started) throw error;
    if (!finished) {
      finished = true;
      opts.onFinish?.(text.length);
      emit({
        type: 'response.failed',
        response: {
          id: responseId,
          object: 'response',
          created_at: createdAt,
          status: 'failed',
          error: { code: 'stream_error', message: error.message },
        },
      });
    }
  } finally {
    if (res.headersSent || started) res.end();
  }
}

/**
 * 解析认证：authProvider 可为路径字符串、auth 对象、或 () => auth 的 getter
 */
function resolveAuth(authProvider) {
  if (typeof authProvider === 'function') {
    const auth = authProvider();
    if (!auth) {
      const error = new Error('没有未屏蔽且可用的 Codex 账号');
      error.code = 'NO_ACTIVE_ACCOUNTS';
      throw error;
    }
    return auth;
  }
  if (authProvider && typeof authProvider === 'object' && authProvider.accessToken) return authProvider;
  return loadAuth(authProvider);
}

/**
 * 调用 Codex 后端（仅支持 Codex token，不支持纯 api_key 调此接口）
 * 支持自动刷新 token：预检查过期 + 401/403 自动刷新重试
 */
export async function callCodexBackend(openaiReq, authProvider = null) {
  const auth = resolveAuth(authProvider);
  if (auth.type !== 'codex') {
    throw new Error('ChatGPT/Codex 反代需要 access_token + account_id，请使用 Codex 登录后的 auth.json');
  }

  // ── 预检查：token 是否即将过期，提前刷新 ──
  let currentToken = auth.accessToken;
  if (isTokenExpiringSoon(currentToken) && auth.accountId) {
    const refreshed = await refreshTokenByAccountId(auth.accountId);
    if (refreshed) {
      currentToken = refreshed.accessToken;
      auth.accessToken = currentToken;
    }
  }

  const body = await buildResponsesRequest(openaiReq, auth.proxyUrl);
  const sessionId = randomUUID();
  const dispatcher = getProxyAgent(auth.proxyUrl);

  // ── 第一次请求 ──
  let headers = {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${currentToken}`,
    'chatgpt-account-id': auth.accountId,
    'session_id': sessionId,
  };
  let res = await fetch(BACKEND_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    dispatcher,
  });

  // ── 401/403 → 刷新 token 重试一次 ──
  if ((res.status === 401 || res.status === 403) && auth.accountId) {
    const refreshed = await refreshTokenByAccountId(auth.accountId);
    if (refreshed && refreshed.accessToken !== currentToken) {
      console.log(`[TokenRefresh] ${auth.accountId.slice(0, 8)}… token 已刷新，重试请求`);
      headers = {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${refreshed.accessToken}`,
        'chatgpt-account-id': auth.accountId,
        'session_id': randomUUID(),
      };
      res = await fetch(BACKEND_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        dispatcher,
      });
      // 更新 auth 对象供后续调用使用
      auth.accessToken = refreshed.accessToken;
    }
  }

  if (!res.ok) {
    const status = res.status;
    if (status === 401 || status === 403) {
      markAccountUnavailable(auth.accountId);
      clearUsage(auth.accountId);
    }
    const text = await res.text();
    throw new Error(`Codex 后端错误 ${status}: ${text.slice(0, 500)}`);
  }
  return { response: res, model: body.model, stream: body.stream, auth };
}

/**
 * 处理一次 Chat Completions 请求：流式或非流式，支持多账号故障切换（失败时自动尝试下一账号）
 * @param {object} openaiReq - 请求体
 * @param {object} res - Express res
 * @param {Function} authProvider - () => auth 或轮询 getter，失败时可多次调用取下一账号
 * @param {number} accountCount - 账号数量，用于故障切换最大重试次数
 * @returns {Promise<object|null>} 成功时返回本次使用的 auth，失败返回 null
 */
export async function handleChatCompletions(
  openaiReq,
  res,
  authProvider = null,
  accountCount = 1,
  responseFormat = 'chat.completion',
) {
  const stream = openaiReq.stream === true;
  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
  const maxTries = Math.max(1, Number(accountCount) || 1);
  let lastError = null;

  for (let tryIndex = 0; tryIndex < maxTries; tryIndex++) {
    try {
      const auth = typeof authProvider === 'function' ? authProvider() : null;
      const provider = auth ? () => auth : authProvider;
      const { response: backendRes, model: backendModel, auth: usedAuth } = await callCodexBackend(openaiReq, provider);
      const who = usedAuth || auth;
      const promptTokens = await estimatePromptTokens(openaiReq);
      if (stream) {
        const onFinish = (completionChars) => {
          if (who?.accountId) {
            recordUsage(who.accountId, {
              prompt_tokens: promptTokens,
              completion_tokens: Math.ceil(completionChars / 4),
            });
          }
        };
        if (responseFormat === 'response') {
          await pipeStreamToResponses(backendRes.body, res, backendModel, {
            promptTokens,
            onFinish,
            tools: openaiReq.tools || [],
            toolChoice: openaiReq.tool_choice ?? 'auto',
          });
          return who ?? null;
        } else {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('Access-Control-Allow-Origin', '*');
          await pipeStreamToOpenAI(backendRes.body, res, backendModel, id, { onFinish });
          return who ?? null;
        }
        return who ?? null;
      }
      const { text, toolCalls } = await parseStreamToCompletion(backendRes.body);
      const completionTokens = Math.ceil(
        (text.length + toolCalls.reduce((sum, call) => sum + call.function.arguments.length, 0)) / 4
      );
      if (who?.accountId) {
        recordUsage(who.accountId, { prompt_tokens: promptTokens, completion_tokens: completionTokens });
      }
      const completion = {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: backendModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: text || null,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      };
      if (responseFormat === 'response') {
        res.json(formatOpenAIResponsesResult({
          id: `resp_${randomUUID().replace(/-/g, '')}`,
          messageId: `msg_${randomUUID().replace(/-/g, '')}`,
          model: backendModel,
          text,
          createdAt: completion.created,
          promptTokens,
          completionTokens,
          toolCalls,
          tools: openaiReq.tools || [],
          toolChoice: openaiReq.tool_choice ?? 'auto',
        }));
      } else {
        res.json(completion);
      }
      return who ?? null;
    } catch (e) {
      lastError = e;
      if (res.headersSent) throw e;
      const status = e.message && /^\D*(\d{3})/.exec(e.message);
      const code = status ? Number(status[1]) : 0;
      const isRetryable = e.code === 'EMPTY_MODEL_RESPONSE' || (code >= 400 && code < 600);
      if (!isRetryable || tryIndex >= maxTries - 1) break;
    }
  }

  if (!res.headersSent) {
    let msg = lastError?.message ?? 'Proxy error';
    if (msg === 'fetch failed' || /^fetch failed/i.test(msg)) {
      msg = 'fetch failed: 无法连接 Codex 后端 (chatgpt.com)。请检查网络/VPN，并确认已添加至少一个 Codex 账号。详见配置页或 README。';
    }
    res.status(lastError?.code === 'NO_ACTIVE_ACCOUNTS' ? 503 : 500).json({
      error: {
        message: msg,
        type: 'proxy_error',
        code: 'internal_error',
      },
    });
  }
  return null;
}
