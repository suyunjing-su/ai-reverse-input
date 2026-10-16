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
test('injects exact model prompt once in chat user text and preserves system/tools', () => {
  const original = { model: 'alpha', system: 'keep', tools: [{ type: 'x' }], messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'hello' }] }] };
  const result = injectPrompt(Buffer.from(JSON.stringify(original)), 'chat', { prompt: 'RULE' });
  const value = JSON.parse(result.body); assert.equal(value.system, 'keep'); assert.deepEqual(value.tools, original.tools); assert.equal(value.messages[1].content[0].type, 'image_url'); assert.equal(value.messages[1].content[1].text, 'RULE\n\nhello');
  const second = injectPrompt(result.body, 'chat', { prompt: 'RULE' }); assert.equal(JSON.parse(second.body).messages[1].content[1].text, 'RULE\n\nhello');
});

test('supports responses string input and anthropic user blocks', () => {
  const response = injectPrompt(Buffer.from(JSON.stringify({ model: 'x', input: 'hello', instructions: 'keep' })), 'responses', { prompt: 'P' });
  assert.equal(JSON.parse(response.body).input, 'P\n\nhello');
  const claude = injectPrompt(Buffer.from(JSON.stringify({ model: 'x', system: 'keep', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }] }] })), 'anthropic', { prompt: 'P' });
  assert.equal(JSON.parse(claude.body).messages[0].content[0].text, 'P\n\nhi');
});

test('does not modify unlocatable or unknown input', () => {
  const body = Buffer.from(JSON.stringify({ model: 'x', messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }));
  assert.equal(injectPrompt(body, 'chat', { prompt: 'P' }).changed, false); assert.equal(detectProtocol('/v1/models'), null);
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
