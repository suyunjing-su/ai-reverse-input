import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { executeResponseRequest, matchesStatus } from '../src/retry/responses-retry.js';

function responseFromChunks(statusCode, chunks, headers = { 'content-type': 'text/event-stream' }) {
  const stream = ReadableFromChunks(chunks);
  return { statusCode, headers, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), destroy() { stream.destroy?.(); } };
}
function ReadableFromChunks(chunks) { return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) { await new Promise((r) => setTimeout(r, 1)); yield Buffer.from(chunk); } } }; }
const retryConfig = { enabled: true, statusRules: [], codeRules: [{ value: 'busy', mode: 'exact', enabled: true }], messageRules: [], maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, exponentialBackoff: false, totalTimeoutMs: 1000, preflightBytes: 64 * 1024, preflightMs: 1000 };

test('HTTP status code rules retry non-stream Responses without a JSON error body', async () => {
  let attempts = 0;
  const result = await executeResponseRequest({ request: { stream: false }, config: { ...retryConfig, codeRules: [], statusRules: [{ status: 429, enabled: true }] }, clientSignal: new AbortController().signal, upstream: async () => { attempts++; return { statusCode: attempts === 1 ? 429 : 200, headers: { 'content-type': 'text/plain' }, async *[Symbol.asyncIterator]() { yield Buffer.from(attempts === 1 ? 'temporarily unavailable' : '{"ok":true}'); } }; }, sendStream: async () => {} });
  assert.equal(matchesStatus(429, { statusRules: [{ status: 429, enabled: true }] }).kind, 'status'); assert.equal(matchesStatus(200, { statusRules: [{ status: 200, enabled: true }] }), null); assert.equal(attempts, 2); assert.deepEqual(JSON.parse(result.body), { ok: true });
});

test('HTTP status code rules retry a streaming Responses attempt before SSE events', async () => {
  let attempts = 0; const delivered = [];
  await executeResponseRequest({ request: { stream: true }, config: { ...retryConfig, codeRules: [], statusRules: [{ status: 503, enabled: true }] }, clientSignal: new AbortController().signal, upstream: async () => { attempts++; return attempts === 1 ? responseFromChunks(503, ['upstream unavailable'], { 'content-type': 'text/event-stream' }) : responseFromChunks(200, ['event: response.created\ndata: {"type":"response.created"}\n\n', 'event: response.completed\ndata: {"type":"response.completed"}\n\n']); }, sendStream: async (_response, prefix, rest, _signal, iterator) => { for (const chunk of prefix) delivered.push(chunk.toString()); if (rest?.length) delivered.push(rest.toString()); for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) delivered.push(chunk.toString()); } });
  assert.equal(attempts, 2); assert.equal(delivered.some((item) => item.includes('upstream unavailable')), false); assert.match(delivered.join(''), /response\.completed/);
});

test('disabled or non-matching HTTP status rules do not retry', async () => {
  let attempts = 0;
  const result = await executeResponseRequest({ request: { stream: false }, config: { ...retryConfig, codeRules: [], statusRules: [{ status: 500, enabled: false }] }, clientSignal: new AbortController().signal, upstream: async () => { attempts++; return { statusCode: 429, headers: { 'content-type': 'text/plain' }, async *[Symbol.asyncIterator]() { yield Buffer.from('no retry'); } }; }, sendStream: async () => {} });
  assert.equal(attempts, 1); assert.equal(result.body.toString(), 'no retry');
});
test('non-stream Responses retries matching JSON error and returns only success', async () => {
  let attempts = 0; const output = [];
  const result = await executeResponseRequest({ request: { stream: false }, config: retryConfig, clientSignal: new AbortController().signal, upstream: async () => { attempts++; return { statusCode: attempts === 1 ? 429 : 200, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(attempts === 1 ? { error: { code: 'busy', message: 'wait' } } : { ok: true })); } }; }, sendStream: async () => {} });
  output.push(result.body.toString()); assert.equal(attempts, 2); assert.deepEqual(JSON.parse(output[0]), { ok: true });
});

test('SSE early failure is discarded and successful attempt is delivered', async () => {
  let attempts = 0; const delivered = []; const response = () => { attempts++; return attempts === 1 ? responseFromChunks(200, ['event: response.created\n\ndata: {"type":"response.created"}\n\n', 'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"busy","message":"later"}}}\n\n']) : responseFromChunks(200, ['event: response.created\n\ndata: {"type":"response.created"}\n\n', 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n', 'event: response.completed\ndata: {"type":"response.completed"}\n\n']); };
  await executeResponseRequest({ request: { stream: true }, config: retryConfig, clientSignal: new AbortController().signal, upstream: async () => response(), sendStream: async (_response, prefix, rest, _signal, iterator) => { for (const chunk of prefix) delivered.push(chunk.toString()); if (rest?.length) delivered.push(rest.toString()); for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) delivered.push(chunk.toString()); } });
  assert.equal(attempts, 2); assert.equal(delivered.some((item) => item.includes('response.failed')), false); assert.equal(delivered.some((item) => item.includes('"delta":"ok"')), true); assert.match(delivered.join(''), /response\.created[\s\S]*\n\n[\s\S]*response\.output_text\.delta/);
});

test('SSE preflight deadline commits without waiting for the next event', async () => {
  const config = { ...retryConfig, preflightMs: 5, preflightBytes: 65536, maxRetries: 0 };
  const delivered = [];
  const stream = { async *[Symbol.asyncIterator]() { await new Promise((r) => setTimeout(r, 30)); yield Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n'); } };
  await executeResponseRequest({ request: { stream: true }, config, clientSignal: new AbortController().signal, upstream: async () => ({ statusCode: 200, headers: { 'content-type': 'text/event-stream' }, ...stream, [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](), destroy() {} }), sendStream: async (_response, prefix, rest, _signal, iterator) => { for (const chunk of prefix) delivered.push(chunk); if (rest?.length) delivered.push(rest); for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) delivered.push(chunk); } });
  assert.match(Buffer.concat(delivered).toString(), /response\.created/);
});
