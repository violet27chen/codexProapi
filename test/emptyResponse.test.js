import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStreamToText,
  pipeStreamToOpenAI,
  pipeStreamToResponses,
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
