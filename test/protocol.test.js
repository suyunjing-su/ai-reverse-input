import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProtocol, injectPrompt } from '../src/protocols/prompt-injection.js';
import { SseParser } from '../src/retry/sse-parser.js';
import { isStatusRetryEndpoint } from '../src/http-utils.js';
import { extractResponsesError, matchesRetry } from '../src/retry/responses-retry.js';

test('status retries are eligible only for the three supported POST interfaces', () => {
  assert.equal(isStatusRetryEndpoint({ method: 'POST', url: '/v1/chat/completions' }), true);
  assert.equal(isStatusRetryEndpoint({ method: 'POST', url: '/v1/responses' }), true);
  assert.equal(isStatusRetryEndpoint({ method: 'POST', url: '/v1/messages' }), true);
  assert.equal(isStatusRetryEndpoint({ method: 'POST', url: '/internal/v1/messages' }), true);
  assert.equal(isStatusRetryEndpoint({ method: 'GET', url: '/v1/messages' }), false);
  assert.equal(isStatusRetryEndpoint({ method: 'POST', url: '/v1/responses/resp_123' }), false);
});
test('injects chat guidance using the native instruction role and preserves messages', () => {
  const original = { model: 'alpha', tools: [{ type: 'x' }], messages: [{ role: 'developer', content: 'native developer' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'hello' }] }] };
  const result = injectPrompt(Buffer.from(JSON.stringify(original)), 'chat', { prompt: 'RULE' });
  const value = JSON.parse(result.body);
  assert.deepEqual(value.tools, original.tools);
  assert.deepEqual(value.messages[0], original.messages[0]);
  assert.deepEqual(value.messages[1], { role: 'developer', content: 'RULE' });
  assert.deepEqual(value.messages[2], original.messages[1]);
  const second = injectPrompt(result.body, 'chat', { prompt: 'RULE' });
  assert.equal(second.changed, false);
});

test('chat injection uses system when only system exists or no instruction exists', () => {
  const withSystem = injectPrompt(Buffer.from(JSON.stringify({ messages: [{ role: 'system', content: 'native' }, { role: 'user', content: 'hello' }] })), 'chat', { prompt: 'RULE' });
  assert.deepEqual(JSON.parse(withSystem.body).messages, [{ role: 'system', content: 'native' }, { role: 'system', content: 'RULE' }, { role: 'user', content: 'hello' }]);
  const withoutInstruction = injectPrompt(Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] })), 'chat', { prompt: 'RULE' });
  assert.deepEqual(JSON.parse(withoutInstruction.body).messages, [{ role: 'system', content: 'RULE' }, { role: 'user', content: 'hello' }]);
});

test('injects Responses instructions and preserves input, tools, and previous response state', () => {
  const original = { model: 'x', instructions: 'native', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }], tools: [{ type: 'function' }], reasoning: { effort: 'high' }, previous_response_id: 'resp_1' };
  const result = injectPrompt(Buffer.from(JSON.stringify(original)), 'responses', { prompt: 'P' });
  const value = JSON.parse(result.body);
  assert.equal(value.instructions, 'native\n\nP');
  assert.deepEqual(value.input, original.input);
  assert.deepEqual(value.tools, original.tools);
  assert.deepEqual(value.reasoning, original.reasoning);
  assert.equal(value.previous_response_id, 'resp_1');
  assert.equal(injectPrompt(result.body, 'responses', { prompt: 'P' }).changed, false);
  const absent = injectPrompt(Buffer.from(JSON.stringify({ input: 'hello' })), 'responses', { prompt: 'P' });
  assert.deepEqual(JSON.parse(absent.body), { input: 'hello', instructions: 'P' });
});

test('injects Anthropic system while preserving string, blocks, and cache metadata', () => {
  const stringSystem = injectPrompt(Buffer.from(JSON.stringify({ system: 'native', messages: [{ role: 'user', content: 'hello' }] })), 'anthropic', { prompt: 'P' });
  assert.equal(JSON.parse(stringSystem.body).system, 'native\n\nP');
  const blocks = [{ type: 'text', text: 'native', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'more' }];
  const result = injectPrompt(Buffer.from(JSON.stringify({ system: blocks, messages: [] })), 'anthropic', { prompt: 'P' });
  const value = JSON.parse(result.body);
  assert.deepEqual(value.system, [...blocks, { type: 'text', text: 'P' }]);
  assert.equal(injectPrompt(result.body, 'anthropic', { prompt: 'P' }).changed, false);
});

test('empty or disabled prompts are a no-op and unsupported routes are not detected', () => {
  const body = Buffer.from(JSON.stringify({ model: 'x', input: 'hello', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(injectPrompt(body, 'responses', { prompt: '  ' }).changed, false);
  assert.equal(injectPrompt(body, 'responses', { prompt: 'P', enabled: false }).changed, false);
  assert.equal(detectProtocol('/v1/completions'), null);
  assert.equal(detectProtocol('/v1/chat/completion'), null);
  assert.equal(detectProtocol('/v1/messages/count_tokens'), null);
  assert.equal(detectProtocol('/v1/models'), null);
});

test('chat prefers developer in a mixed instruction prefix and preserves tool exchanges', () => {
  const native = [{ role: 'developer', content: 'workflow' }, { role: 'system', content: [{ type: 'text', text: 'identity' }] }];
  const conversation = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'input_audio', input_audio: { data: 'eA==', format: 'wav' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ];
  const result = injectPrompt(Buffer.from(JSON.stringify({ messages: [...native, ...conversation] })), 'chat', { prompt: '  fixed\n' });
  assert.deepEqual(JSON.parse(result.body).messages, [...native, { role: 'developer', content: '  fixed\n' }, ...conversation]);
});

test('missing and empty instructions are initialized without changing unrelated fields', () => {
  for (const [protocol, field] of [['responses', 'instructions'], ['anthropic', 'system']]) {
    for (const original of [undefined, null, '']) {
      const request = { [field]: original, cache_control: { type: 'ephemeral' }, previous_response_id: 'resp_2' };
      const injected = injectPrompt(Buffer.from(JSON.stringify(request)), protocol, { prompt: '  P\n' });
      assert.equal(injected.changed, true);
      assert.deepEqual(JSON.parse(injected.body), { ...request, [field]: '  P\n' });
      const repeated = injectPrompt(injected.body, protocol, { prompt: '  P\n' });
      assert.equal(repeated.changed, false);
      assert.equal(repeated.body, injected.body);
    }
  }
});

test('unexpected instruction formats and interleaved chat instructions are passed through unchanged', () => {
  for (const [protocol, original] of [
    ['responses', { instructions: ['unexpected'] }],
    ['anthropic', { system: { text: 'unexpected' } }],
    ['anthropic', { system: [null] }],
    ['chat', { messages: null }],
    ['chat', { messages: [{ role: 'user', content: 'first' }, { role: 'developer', content: 'late' }] }],
  ]) {
    const body = Buffer.from(JSON.stringify(original, null, 2));
    const result = injectPrompt(body, protocol, { prompt: 'P' });
    assert.equal(result.changed, false);
    assert.equal(result.body, body);
  }
});

test('parses split CRLF SSE with multiline data and event type', () => {
  const parser = new SseParser(); const first = Buffer.from('event: response.created\r\ndata: {"type":"response.created",\r\n');
  assert.equal(parser.feed(first).length, 0); const events = parser.feed(Buffer.from('data:"id":"r"}\r\n\r\n: ping\n\nevent: error\ndata: {"error":{"code":"busy","message":"later"}}\n\n'));
  assert.equal(events.length, 3); assert.equal(events[0].type, 'response.created'); const errorEvent = events.find((event) => event.type === 'error'); assert.ok(errorEvent); assert.equal(errorEvent.json.error.code, 'busy');
});

test('extracts nested errors and applies OR matching', () => {
  const error = extractResponsesError({ response: { error: { code: 'upstream_error', message: 'Too many pending requests, please retry later' } } });
  assert.equal(matchesRetry(error, { codeRules: [{ value: 'other', mode: 'exact', enabled: true }], messageRules: [{ value: 'TOO MANY', mode: 'substring-ci', enabled: true }] }).kind, 'message');
  assert.equal(matchesRetry(error, { codeRules: [{ value: 'upstream_error', mode: 'exact', enabled: true }], messageRules: [] }).kind, 'code');
});
