import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStreamToCompletion,
  parseStreamToText,
  pipeStreamToOpenAI,
  pipeStreamToResponses,
  messagesToInput,
} from '../src/proxy.js';

function sseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function mockResponse() {
  return {
    headersSent: false,
    writes: [],
    setHeader() {},
    write(chunk) {
      this.headersSent = true;
      this.writes.push(chunk);
    },
    end() {},
  };
}

test('parseStreamToText rejects completed responses with no text', async () => {
  await assert.rejects(
    parseStreamToText(sseStream([{ type: 'response.completed' }])),
    { code: 'EMPTY_MODEL_RESPONSE' },
  );
});

test('stream converters reject empty completions before sending a response', async () => {
  for (const convert of [
    (stream, res) => pipeStreamToOpenAI(stream, res, 'test-model', 'test-id'),
    (stream, res) => pipeStreamToResponses(stream, res, 'test-model'),
  ]) {
    const res = mockResponse();
    await assert.rejects(convert(sseStream([{ type: 'response.completed' }]), res), {
      code: 'EMPTY_MODEL_RESPONSE',
    });
    assert.equal(res.headersSent, false);
    assert.deepEqual(res.writes, []);
  }
});

test('response parsers recover text emitted only in completed events', async () => {
  const completedEvents = [
    { type: 'response.output_text.done', text: 'Finished text' },
  ];
  assert.equal(await parseStreamToText(sseStream(completedEvents)), 'Finished text');

  for (const convert of [
    (stream, res) => pipeStreamToOpenAI(stream, res, 'test-model', 'test-id'),
    (stream, res) => pipeStreamToResponses(stream, res, 'test-model'),
  ]) {
    const res = mockResponse();
    await convert(sseStream([{
      type: 'response.completed',
      response: {
        output: [{ content: [{ type: 'output_text', text: 'Finished text' }] }],
      },
    }]), res);
    assert.ok(res.writes.some((chunk) => chunk.includes('Finished text')));
  }
});

test('function-call-only responses are returned as OpenAI tool calls', async () => {
  const result = await parseStreamToCompletion(sseStream([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"/repo"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"/repo"}' },
  ]));

  assert.equal(result.text, '');
  assert.deepEqual(result.toolCalls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'list_files', arguments: '{"path":"/repo"}' },
  }]);
});

test('stream converter returns function calls instead of treating them as empty output', async () => {
  const res = mockResponse();
  await pipeStreamToOpenAI(sseStream([{
    type: 'response.completed',
    response: {
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'list_files',
        arguments: '{"path":"/repo"}',
      }],
    },
  }]), res, 'test-model', 'test-id');

  assert.ok(res.writes.some((chunk) => chunk.includes('"finish_reason":"tool_calls"')));
  assert.ok(res.writes.some((chunk) => chunk.includes('"name":"list_files"')));
});

test('tool results are serialized as function-call input items for the next turn', async () => {
  const input = await messagesToInput([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'list_files', arguments: '{"path":"/repo"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '["src"]' },
    { role: 'user', content: 'Open src/index.js' },
  ]);

  assert.deepEqual(input.slice(0, 2), [
    { type: 'function_call', call_id: 'call_1', name: 'list_files', arguments: '{"path":"/repo"}' },
    { type: 'function_call_output', call_id: 'call_1', output: '["src"]' },
  ]);
  assert.equal(input[2].type, 'message');
});
