import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser } from '../src/sse.js';

test('SSE parser uses event names when JSON omits type and flushes final chunks', () => {
  const events = [];
  const parse = createSSEParser((event) => events.push(event));
  parse('event: response.output_text.delta\ndata: {"delta":"hel');
  parse('lo"}', true);

  assert.deepEqual(events, [
    { type: 'response.output_text.delta', delta: 'hello' },
  ]);
});

test('SSE parser handles data-only events and the done sentinel', () => {
  const events = [];
  const parse = createSSEParser((event) => events.push(event));
  parse('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
  parse('data: [DONE]\n\n');

  assert.deepEqual(events, [
    { type: 'response.output_text.delta', delta: 'ok' },
    { type: '[DONE]' },
  ]);
});
