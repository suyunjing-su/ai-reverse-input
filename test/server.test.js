import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise((resolve) => server.close(resolve)); return port; }
function request(port, pathName, options = {}, body = '') { return new Promise((resolve, reject) => { const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method: options.method || 'GET', headers: options.headers || {} }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }); req.once('error', reject); req.end(body); }); }
async function waitFor(port) { for (let i = 0; i < 80; i++) { try { const result = await request(port, '/healthz'); if (result.status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 25)); } throw new Error('gateway did not start'); }
test('server authenticates admin, hot-applies prompt rules, and forwards safely', async (t) => {
  let seen;
  const upstreamServer = http.createServer((req, res) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { seen = { method: req.method, url: req.url, auth: req.headers.authorization, removed: req.headers['x-remove'], cookie: req.headers.cookie, body: Buffer.concat(chunks).toString() }; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }); });
  const upstreamPort = await listen(upstreamServer); const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reserve-gateway-'));
  const reservation = await freePort();
  const env = { ...process.env, NEW_API_BASE_URL: `http://127.0.0.1:${upstreamPort}/api`, HOST: '127.0.0.1', PORT: String(reservation), DATA_DIR: dataDir, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-secure-test-password' };
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise((resolve) => upstreamServer.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  await waitFor(reservation);
  const login = await request(reservation, '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' } }, JSON.stringify({ username: 'admin', password: 'a-secure-test-password' }));
  assert.equal(login.status, 200); const cookie = login.headers['set-cookie'][0].split(';')[0];
  const add = await request(reservation, '/admin/api/prompts', { method: 'POST', headers: { cookie, 'content-type': 'application/json' } }, JSON.stringify({ modelId: 'alpha', prompt: 'RULE' })); assert.equal(add.status, 201);
  const body = JSON.stringify({ model: 'alpha', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] });
  const forwarded = await request(reservation, '/v1/chat/completions?trace=1', { method: 'POST', headers: { cookie: 'gateway_session=admin-secret; foo=bar', authorization: 'Bearer secret', connection: 'x-remove', 'x-remove': 'must-not-pass', 'content-type': 'application/json' } }, body);
  const forwardedJson = JSON.parse(seen.body); assert.equal(forwarded.status, 200); assert.equal(seen.url, '/api/v1/chat/completions?trace=1'); assert.equal(seen.auth, 'Bearer secret'); assert.equal(seen.removed, undefined); assert.equal(seen.cookie, 'foo=bar'); assert.equal(forwardedJson.messages[1].content.startsWith('RULE'), true); assert.equal(forwardedJson.messages[1].content.endsWith('hello'), true);
});
