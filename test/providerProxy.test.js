import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiToAnthropic, anthropicToOpenai,
  openaiToGoogle, googleToOpenai, fetchProviderModels, forwardChatCompletion,
} from '../src/providerProxy.js';

function fakeRes() {
  return {
    statusCode: 200, body: null, headersSent: false,
    setHeader() {}, write() {}, end() {},
    json(o) { this.body = o; },
    status(c) { this.statusCode = c; return this; },
  };
}

test('fetchProviderModels: openai /models', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /\/v1\/models$/);
    assert.equal(opts.headers.Authorization, 'Bearer k');
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }); } };
  };
  try { assert.deepEqual(await fetchProviderModels({ type: 'openai', base_url: 'https://x.com/v1', api_key: 'k' }), ['a', 'b']); }
  finally { globalThis.fetch = real; }
});

test('fetchProviderModels: google 去 models/ 前缀', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/v1beta\/models$/);
    return { ok: true, status: 200, async text() { return JSON.stringify({ models: [{ name: 'models/gemini-2.0-flash' }] }); } };
  };
  try { assert.deepEqual(await fetchProviderModels({ type: 'google', base_url: 'https://generativelanguage.googleapis.com', api_key: 'k' }), ['gemini-2.0-flash']); }
  finally { globalThis.fetch = real; }
});

test('fetchProviderModels: 非 2xx 抛错', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, async text() { return 'unauthorized'; } });
  try { await assert.rejects(() => fetchProviderModels({ type: 'openai', base_url: 'https://x.com/v1', api_key: 'k' }), /401/); }
  finally { globalThis.fetch = real; }
});

test('openaiToAnthropic: system 抽出、role 映射、max_tokens 默认', () => {
  const out = openaiToAnthropic({
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'again' }] },
    ],
  });
  assert.equal(out.system, 'be nice');
  assert.equal(out.max_tokens, 4096);
  assert.deepEqual(out.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(out.messages[2].content, 'again');
});

test('anthropicToOpenai: 文本与 usage/finish 映射', () => {
  const o = anthropicToOpenai({
    id: 'msg_1',
    content: [{ type: 'text', text: 'world' }],
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: 'max_tokens',
  }, 'claude-3-5-sonnet');
  assert.equal(o.object, 'chat.completion');
  assert.equal(o.choices[0].message.content, 'world');
  assert.equal(o.choices[0].finish_reason, 'length');
  assert.equal(o.usage.total_tokens, 15);
});

test('openaiToGoogle: contents/systemInstruction/generationConfig', () => {
  const out = openaiToGoogle({
    model: 'gemini-2.0-flash',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ],
    temperature: 0.2,
    max_tokens: 256,
  });
  assert.equal(out.systemInstruction.parts[0].text, 'sys');
  assert.deepEqual(out.contents.map((c) => c.role), ['user', 'model']);
  assert.equal(out.generationConfig.temperature, 0.2);
  assert.equal(out.generationConfig.maxOutputTokens, 256);
});

test('googleToOpenai: 文本/usage/finish 映射', () => {
  const o = googleToOpenai({
    candidates: [{ content: { parts: [{ text: 'ans' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
  }, 'gemini-2.0-flash');
  assert.equal(o.choices[0].message.content, 'ans');
  assert.equal(o.choices[0].finish_reason, 'stop');
  assert.equal(o.usage.total_tokens, 7);
});

test('forwardChatCompletion: 多个 Key 自动轮询（每次请求换一个）', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'x' } }] }; } };
  };
  const p = { id: 'rr-p1', type: 'openai', base_url: 'https://x.com/v1', api_keys: ['k1', 'k2', 'k3'] };
  try {
    for (let i = 0; i < 4; i++) await forwardChatCompletion(p, { model: 'm', messages: [] }, fakeRes());
    assert.deepEqual(seen, ['Bearer k1', 'Bearer k2', 'Bearer k3', 'Bearer k1']);
  } finally { globalThis.fetch = real; }
});

test('forwardChatCompletion: 某个 Key 被拒(401)自动换下一个 Key 成功', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    if (opts.headers.Authorization === 'Bearer k1') return { ok: false, status: 401, async text() { return 'bad key'; } };
    return { ok: true, status: 200, async json() { return { choices: [{ message: { content: 'ok' } }] }; } };
  };
  const p = { id: 'rr-p2', type: 'openai', base_url: 'https://x.com/v1', api_keys: ['k1', 'k2'] };
  const res = fakeRes();
  try {
    await forwardChatCompletion(p, { model: 'm', messages: [] }, res);
    assert.deepEqual(seen, ['Bearer k1', 'Bearer k2'], '应先试 k1 失败再试 k2');
    assert.equal(res.statusCode, 200);
  } finally { globalThis.fetch = real; }
});

test('forwardChatCompletion: 全部 Key 都失败时透传上游错误码', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    return { ok: false, status: 429, async text() { return 'rate limited'; } };
  };
  const p = { id: 'rr-p3', type: 'openai', base_url: 'https://x.com/v1', api_keys: ['k1', 'k2'] };
  const res = fakeRes();
  try {
    await forwardChatCompletion(p, { model: 'm', messages: [] }, res);
    assert.equal(seen.length, 2, '两个 Key 都试过');
    assert.equal(res.statusCode, 429);
    assert.match(res.body.error.message, /429/);
  } finally { globalThis.fetch = real; }
});

test('fetchProviderModels: 多 Key 时换 Key 重试', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(opts.headers.Authorization);
    if (opts.headers.Authorization === 'Bearer bad') return { ok: false, status: 403, async text() { return 'forbidden'; } };
    return { ok: true, status: 200, async text() { return JSON.stringify({ data: [{ id: 'a' }] }); } };
  };
  try {
    assert.deepEqual(await fetchProviderModels({ type: 'openai', base_url: 'https://x.com/v1', api_key: 'bad\ngood' }), ['a']);
    assert.deepEqual(seen, ['Bearer bad', 'Bearer good']);
  } finally { globalThis.fetch = real; }
});

test('forwardChatCompletion: anthropic 用 x-api-key 轮询并翻译响应', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, key: opts.headers['x-api-key'], ver: opts.headers['anthropic-version'], payload: JSON.parse(opts.body) });
    return { ok: true, status: 200, async json() { return { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 2, output_tokens: 3 }, stop_reason: 'end_turn' }; } };
  };
  const p = { id: 'rr-anth', type: 'anthropic', base_url: 'https://api.anthropic.com/v1', api_keys: ['a1', 'a2'] };
  const r1 = fakeRes(); const r2 = fakeRes();
  try {
    await forwardChatCompletion(p, { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'q' }] }, r1);
    await forwardChatCompletion(p, { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'q' }] }, r2);
    assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen[0].ver, '2023-06-01');
    assert.equal(seen[0].key, 'a1');
    assert.equal(seen[1].key, 'a2', '第二次应换下一个 Key');
    assert.equal(seen[0].payload.model, 'claude-3-5-sonnet');
    assert.equal(r1.body.object, 'chat.completion');
    assert.equal(r1.body.choices[0].message.content, 'hi');
  } finally { globalThis.fetch = real; }
});

test('forwardChatCompletion: google 用 x-goog-api-key 与 generateContent 端点', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, key: opts.headers['x-goog-api-key'] });
    return { ok: true, status: 200, async json() { return { candidates: [{ content: { parts: [{ text: 'yo' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 5 } }; } };
  };
  const p = { id: 'rr-g', type: 'google', base_url: 'https://generativelanguage.googleapis.com', api_keys: ['g1'] };
  const res = fakeRes();
  try {
    await forwardChatCompletion(p, { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'q' }] }, res);
    assert.match(seen[0].url, /\/v1beta\/models\/gemini-2\.0-flash:generateContent$/);
    assert.equal(seen[0].key, 'g1');
    assert.equal(res.body.choices[0].message.content, 'yo');
  } finally { globalThis.fetch = real; }
});
