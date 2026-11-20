import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { SseParser } from '../src/retry/sse-parser.js';

function parseEvents(body) { return new SseParser().feed(body).flatMap((event) => event.json ? [event.json] : []); }

const toolArguments = '{"location":"San Francisco"}';
const toolCall = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: toolArguments };
const toolEvents = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: toolCall.id, output_index: 0, delta: toolArguments.slice(0, 14) },
  { type: 'response.function_call_arguments.delta', item_id: toolCall.id, output_index: 0, delta: toolArguments.slice(14) },
  { type: 'response.function_call_arguments.done', item_id: toolCall.id, output_index: 0, arguments: toolArguments },
  { type: 'response.output_item.done', output_index: 0, item: toolCall },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [toolCall] } },
].map((event, i) => ({ ...event, sequence_number: i + 1 }));
const sseFrame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
function request(port, pathName, options = {}, body = '') { return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method: options.method || 'GET', headers: options.headers || {} }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }); req.once('error', reject); req.end(body); }); }
async function waitFor(port) { for (let i = 0; i < 80; i++) { try { const result = await request(port, '/healthz'); if (result.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 25)); } throw new Error('gateway did not start'); }
test('server authenticates admin, hot-applies prompt rules, and forwards safely', async (t) => {
  const attempts = [];
  const upstreamServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const seen = { url: req.url, auth: req.headers.authorization, removed: req.headers['x-remove'], cookie: req.headers.cookie, length: req.headers['content-length'], body };
    attempts.push(seen);
    if (req.url === '/api/v1/responses?retry=stream') {
      const first = attempts.filter((attempt) => attempt.url === seen.url).length === 1;
      res.writeHead(first ? 429 : 200, { 'content-type': 'text/event-stream' });
      res.end(first ? 'retry me' : 'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1"}}\n\n');
    } else if (req.url === '/api/v1/responses?compat=gzip') {
      const first = attempts.filter((attempt) => attempt.url === seen.url).length === 1;
      const sse = first ? 'data: {"type":"error","error":{"code":"busy","message":"discard me"}}\n\n' :
        'event: response.created\r\ndata: {"type":"response.created",\r\ndata: "response":{"id":"resp_gzip","status":"in_progress"}}\r\n\r\n';
      const compressed = gzipSync(sse);
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'content-encoding': 'gzip', 'content-length': compressed.length, etag: '"compressed"' });
      res.end(compressed);
    } else if (req.url === '/api/v1/responses?compat=tool-call') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(toolEvents.slice(0, 2).map(sseFrame).join(''));
      res.end(toolEvents.slice(2).map(sseFrame).join(''));
    } else if (req.url === '/api/v1/responses?compat=direct') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp_direct","status":"in_progress"}}\r\n\r\n');
    } else if (req.url === '/api/v1/responses?retry=json' && attempts.filter((attempt) => attempt.url === seen.url).length === 1) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"retry me"}}');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  });
  const upstreamPort = await listen(upstreamServer); const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reserve-gateway-'));
  const reservation = await freePort();
  const env = { ...process.env, NEW_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/api`, HOST: '127.0.0.1', PORT: String(reservation), DATA_DIR: dataDir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-secure-test-password' };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise((resolve) => upstreamServer.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  await waitFor(reservation);
  const login = await request(reservation, '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ username: 'admin', password: 'a-secure-test-password' }));
  assert.equal(login.status, 200); const cookie = login.headers['set-cookie'][0].split(';')[0];
  const add = await request(reservation, '/admin/api/prompts', { method: 'POST', headers: { cookie, 'content-type': 'application/json' } }, JSON.stringify({ modelId: 'alpha', prompt: 'RULE' })); assert.equal(add.status, 201);
  const statusRule = await request(reservation, '/admin/api/retry-rules/status', { method: 'POST', headers: { cookie, 'content-type': 'application/json' } }, JSON.stringify({ status: 429 })); assert.equal(statusRule.status, 201); assert.equal(JSON.parse(statusRule.body).retry.statusRules[0].status, 429);
  const chat = { model: 'alpha', messages: [{ role: 'system', content: 'native system' }, { role: 'user', content: 'hello' }] };
  const forwarded = await request(reservation, '/v1/chat/completions?trace=1', { method: 'POST', headers: { cookie: 'gateway_session=admin-secret; foo=bar', authorization: 'Bearer secret', connection: 'x-remove', 'x-remove': 'must-not-pass', 'content-type': 'application/json' } }, JSON.stringify(chat));
  const seen = attempts.at(-1);
  assert.equal(forwarded.status, 200);
  assert.equal(seen.url, '/api/v1/chat/completions?trace=1');
  assert.equal(seen.auth, 'Bearer secret');
  assert.equal(seen.removed, undefined);
  assert.equal(seen.cookie, 'foo=bar');
  assert.deepEqual(JSON.parse(seen.body), { ...chat, messages: [chat.messages[0], { role: 'system', content: 'RULE' }, chat.messages[1]] });

  const post = (url, body) => request(reservation, url, { method: 'POST', headers: { 'content-type': 'application/json' } }, body);
  const messages = { ...chat, system: [{ type: 'text', text: 'native', cache_control: { type: 'ephemeral' } }], messages: [chat.messages[1]] };
  assert.equal((await post('/v1/messages', JSON.stringify(messages))).status, 200);
  assert.deepEqual(JSON.parse(attempts.at(-1).body), { ...messages, system: [...messages.system, { type: 'text', text: 'RULE' }] });
  const compatInput = { model: 'alpha', input: 'hello', stream: true };
  const compatResponse = await post('/v1/responses?compat=direct', JSON.stringify(compatInput));
  assert.equal(compatResponse.status, 200);
  assert.match(compatResponse.body.toString(), /"model":"alpha"/);

  const toolBody = JSON.stringify({ model: 'tool-model', input: 'weather', stream: true });
  const checkToolStream = async () => {
    const reply = await post('/v1/responses?compat=tool-call', toolBody);
    assert.equal(reply.status, 200);
    const expected = toolEvents.map((event) => {
      if (event.type === 'response.created') return { ...event, response: { ...event.response, model: 'tool-model' } };
      if (event.type === 'response.output_item.done') return { ...event, item: { ...event.item, status: 'completed' } };
      return event;
    });
    assert.deepEqual(parseEvents(reply.body), expected);
    assert.equal(reply.body.toString(), expected.map(sseFrame).join(''));
  };
  await checkToolStream();

  const retrySettings = await request(reservation, '/admin/api/retry', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' } }, JSON.stringify({ enabled: true, maxRetries: 1, baseDelayMs: 0, codeRules: [{ value: 'busy', mode: 'exact', enabled: true }] }));
  assert.equal(retrySettings.status, 200);
  await checkToolStream();
  assert.equal(attempts.filter(({ url }) => url === '/api/v1/responses?compat=tool-call').length, 2);

  const continuation = JSON.stringify({ model: 'tool-model', previous_response_id: 'resp_1', input: [{ type: 'function_call_output', call_id: toolCall.call_id, output: '{"temperature":18}' }] }, null, 2);
  assert.equal((await post('/v1/responses', continuation)).status, 200);
  assert.equal(attempts.at(-1).body.toString(), continuation);

  const gzipResponse = await post('/v1/responses?compat=gzip', JSON.stringify({ model: 'gzip-model', input: 'hello' }));
  assert.equal(gzipResponse.status, 200);
  for (const header of ['content-encoding', 'content-length', 'etag']) assert.equal(gzipResponse.headers[header], undefined);
  assert.deepEqual(parseEvents(gzipResponse.body), [{ type: 'response.created', response: { id: 'resp_gzip', status: 'in_progress', model: 'gzip-model' } }]);
  assert.equal(attempts.filter(({ url }) => url === '/api/v1/responses?compat=gzip').length, 2);
  for (const stream of [false, true]) {
    const input = { model: 'alpha', input: 'hello', instructions: 'native Codex', previous_response_id: 'resp_1', stream };
    const url = `/v1/responses?retry=${stream ? 'stream' : 'json'}`;
    const response = await post(url, JSON.stringify(input));
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), stream ? /response\.completed/ : /"ok":true/);
    const retries = attempts.filter((attempt) => attempt.url === `/api${url}`);
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0].body, retries[1].body);
    assert.deepEqual(JSON.parse(retries[0].body), { ...input, instructions: 'native Codex', input: [{ role: 'developer', content: 'RULE' }, { role: 'user', content: 'hello' }] });
    assert.deepEqual(retries.map((attempt) => Number(attempt.length)), [retries[0].body.length, retries[0].body.length]);
  }

  const original = JSON.stringify(chat, null, 2);
  for (const url of ['/v1/chat/completion', '/v1/completions', '/v1/messages/count_tokens', '/v1/models']) {
    assert.equal((await post(url, original)).status, 200);
    assert.equal(attempts.at(-1).body.toString(), original);
  }
  assert.equal((await request(reservation, '/v1/messages', { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(original) } }, original)).status, 200);
  assert.equal(attempts.at(-1).body.toString(), original);
  const state = await request(reservation, '/admin/api/state', { headers: { cookie } });
  assert.equal(JSON.parse(state.body).metrics.promptHits, 5);
  assert.equal(JSON.parse(state.body).promptRules[0].hits, 5);
});
