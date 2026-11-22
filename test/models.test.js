import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalog } from '../src/modelCatalog.js';
import {
  normalizeClaudeMessagesRequest,
  normalizeOpenAIResponsesRequest,
  formatOpenAIResponsesResult,
  pipeStreamToResponses,
} from '../src/proxy.js';

test('parseModelCatalog returns unique visible model IDs', () => {
  const ids = parseModelCatalog({
    models: [
      { slug: 'model-new', visibility: 'list' },
      { slug: 'model-hidden', visibility: 'hide' },
      { slug: 'model-new', visibility: 'list' },
      { slug: 'invalid/model', visibility: 'list' },
      { slug: 'model-unlisted' },
    ],
  });

  assert.deepEqual(ids, ['model-new']);
});

test('parseModelCatalog rejects an invalid catalog response', () => {
  assert.throws(() => parseModelCatalog({}), /缺少 models 数组/);
});

test('normalizeClaudeMessagesRequest converts Claude text, system, and image blocks', () => {
  const normalized = normalizeClaudeMessagesRequest({
    model: 'claude-compatible-model',
    system: 'Be concise',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    }],
    stream: false,
  });

  assert.equal(normalized.model, 'claude-compatible-model');
  assert.equal(normalized.stream, false);
  assert.deepEqual(normalized.messages[0], { role: 'system', content: 'Be concise' });
  assert.equal(normalized.messages[1].content[0].text, 'Describe this image');
  assert.equal(normalized.messages[1].content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('normalizeOpenAIResponsesRequest converts input and instructions into proxy messages', () => {
  const normalized = normalizeOpenAIResponsesRequest({
    model: 'gpt-compatible-model',
    instructions: 'Be concise',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Hello' }],
    }],
    stream: true,
  });

  assert.equal(normalized.model, 'gpt-compatible-model');
  assert.equal(normalized.stream, true);
  assert.deepEqual(normalized.messages, [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  ]);
});

test('normalizeOpenAIResponsesRequest rejects unsupported input shapes', () => {
  assert.throws(() => normalizeOpenAIResponsesRequest({ input: { text: 'Hello' } }), /string 或 array 类型的 input/);
  assert.throws(
    () => normalizeOpenAIResponsesRequest({ input: 'Hello', tools: [{ type: 'function', name: 'lookup' }] }),
    /暂不支持 tools/,
  );
});

test('formatOpenAIResponsesResult returns the Responses API output shape', () => {
  const response = formatOpenAIResponsesResult({
    id: 'resp_test',
    messageId: 'msg_test',
    model: 'gpt-compatible-model',
    text: 'Hello',
    createdAt: 123,
    promptTokens: 2,
    completionTokens: 1,
  });

  assert.equal(response.object, 'response');
  assert.equal(response.status, 'completed');
  assert.equal(response.output[0].content[0].type, 'output_text');
  assert.equal(response.output[0].content[0].text, 'Hello');
  assert.equal(response.usage.total_tokens, 3);
});

test('pipeStreamToResponses emits Responses SSE events and a completed response', async () => {
  const encoder = new TextEncoder();
  const backendStream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'
        + 'data: [DONE]\n\n',
      ));
      controller.close();
    },
  });
  const writes = [];
  let ended = false;
  let finishedChars = 0;
  const response = {
    setHeader() {},
    write(chunk) { writes.push(chunk); },
    end() { ended = true; },
  };

  await pipeStreamToResponses(backendStream, response, 'gpt-compatible-model', {
    promptTokens: 2,
    onFinish(chars) { finishedChars = chars; },
  });

  const eventTypes = writes
    .filter((chunk) => chunk.startsWith('event: '))
    .map((chunk) => chunk.slice(7, chunk.indexOf('\n')));
  assert.ok(eventTypes.includes('response.output_text.delta'));
  assert.equal(eventTypes.at(-1), 'response.completed');
  assert.equal(writes.some((chunk) => chunk.includes('[DONE]')), false);
  assert.equal(ended, true);
  assert.equal(finishedChars, 2);
});
