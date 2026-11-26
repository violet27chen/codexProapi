import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiToAnthropic, anthropicToOpenai,
  openaiToGoogle, googleToOpenai,
} from '../src/providerProxy.js';

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
