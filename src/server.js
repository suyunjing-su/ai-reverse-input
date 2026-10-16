import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config-store.js';
import { handleProxy } from './proxy.js';
import { sendJson, safeError } from './http-utils.js';

loadDotEnv();
const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, '..', 'public');
const port = positiveIntegerEnv('PORT', 8787, 1, 65535);
const host = process.env.HOST || '127.0.0.1';
const dataDir = process.env.DATA_DIR || path.join(root, '..', 'data');
const upstream = process.env.NEW_API_BASE_URL;
if (!upstream) { console.error('NEW_API_BASE_URL is required'); process.exit(1); }
try { validateUpstream(upstream); } catch (error) { console.error(error.message); process.exit(1); }
const store = new ConfigStore(dataDir, upstream); await store.init();
const sessions = new Map();
const recentLogs = [];
const loginFailures = new Map();
const maxSessions = 10000;
const limits = { maxRequestBodyBytes: positiveIntegerEnv('MAX_REQUEST_BODY_BYTES', 16 * 1024 * 1024, 1024, 256 * 1024 * 1024), maxResponseBodyBytes: positiveIntegerEnv('MAX_RESPONSE_BODY_BYTES', 32 * 1024 * 1024, 1024, 512 * 1024 * 1024) };
const logger = { info(message, fields = {}) { const entry = { at: new Date().toISOString(), level: 'info', message, ...fields }; recentLogs.push(entry); if (recentLogs.length > 100) recentLogs.shift(); if (process.env.LOG_LEVEL !== 'silent') console.log(JSON.stringify(entry)); }, warn(message, fields = {}) { const entry = { at: new Date().toISOString(), level: 'warn', message, ...fields }; recentLogs.push(entry); if (recentLogs.length > 100) recentLogs.shift(); console.warn(JSON.stringify(entry)); } };


function positiveIntegerEnv(name, fallback, min, max) { const value = process.env[name]; if (value === undefined || value === '') return fallback; const number = Number(value); if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return number; }

function loadDotEnv() {
  try {
    const contents = readFileSync('.env', 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const server = http.createServer(async (req, res) => {
  try { await route(req, res); } catch (error) { logger.warn('unhandled request error', { reason: safeError(error) }); if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: { message: error.statusCode ? error.message : 'Internal server error' } }); else res.destroy(); }
});
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
server.headersTimeout = 30000;
server.keepAliveTimeout = 5000;
server.listen(port, host, () => logger.info('gateway started', { host, port }));

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok', upstreamConfigured: Boolean(store.snapshot().upstreamUrl) });
  if (url.pathname.startsWith('/admin/api/')) return adminApi(req, res, url);
  if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/')) return serveStatic(res, 'admin.html');
  if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'admin.html');
  if (url.pathname.startsWith('/assets/')) return serveStatic(res, url.pathname.slice('/assets/'.length));
  return handleProxy(req, res, { store, logger, limits });
}

function getCookie(req, name) { const value = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`)); return value ? decodeURIComponent(value.slice(name.length + 1)) : null; }
function authenticated(req) { const token = getCookie(req, 'gateway_session'); const session = token && sessions.get(token); if (!session) return null; if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; } return session; }

async function adminApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/admin/api/login') {
    const remote = req.socket.remoteAddress || 'unknown'; const now = Date.now(); const failure = loginFailures.get(remote); if (failure && failure.resetAt <= now) loginFailures.delete(remote); const current = loginFailures.get(remote); if (current && current.count >= 5) return sendJson(res, 429, { error: { message: 'Too many login attempts' } });
    const payload = await readJson(req, 16 * 1024);
    if (!payload?.username || !payload?.password || !await store.verifyAdmin(payload.username, payload.password)) { const entry = loginFailures.get(remote) || { count: 0, resetAt: now + 60000 }; entry.count++; loginFailures.set(remote, entry); return sendJson(res, 401, { error: { message: 'Invalid credentials' } }); }
    loginFailures.delete(remote);
    const token = crypto.randomBytes(32).toString('base64url');
    if (sessions.size >= maxSessions) { const oldest = sessions.keys().next().value; if (oldest) sessions.delete(oldest); }
    sessions.set(token, { username: payload.username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    const secureCookie = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''; res.setHeader('set-cookie', `gateway_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=28800${secureCookie}`);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/logout') { const token = getCookie(req, 'gateway_session'); if (token) sessions.delete(token); const secureCookie = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''; res.setHeader('set-cookie', `gateway_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0${secureCookie}`); return sendJson(res, 200, { ok: true }); }
  if (!authenticated(req)) return sendJson(res, 401, { error: { message: 'Authentication required' } });
  const config = store.snapshot();
  if (req.method === 'GET' && url.pathname === '/admin/api/state') return sendJson(res, 200, publicState(config));
  if (req.method === 'GET' && url.pathname === '/admin/api/logs') return sendJson(res, 200, recentLogs.slice(-100));
  if (req.method === 'PUT' && url.pathname === '/admin/api/settings') { const body = await readJson(req, 32 * 1024); if (body.upstreamUrl !== undefined) validateUpstream(body.upstreamUrl); await store.update((next) => { if (body.upstreamUrl !== undefined) next.upstreamUrl = body.upstreamUrl; return next; }); return sendJson(res, 200, publicState(store.snapshot())); }
  if (req.method === 'PUT' && url.pathname === '/admin/api/retry') { const body = await readJson(req, 128 * 1024); await store.update((next) => { next.retry = body; return next; }); return sendJson(res, 200, publicState(store.snapshot())); }
  const retryMatch = url.pathname.match(/^\/admin\/api\/retry-rules\/(status|code|message)(?:\/([^/]+))?$/);
  if (retryMatch) return retryRuleApi(req, res, retryMatch[1], retryMatch[2] ? decodeURIComponent(retryMatch[2]) : null);
  if (req.method === 'POST' && url.pathname === '/admin/api/prompts') { const body = await readJson(req, 128 * 1024); if (!body?.modelId || typeof body.prompt !== 'string') return sendJson(res, 400, { error: { message: 'modelId and prompt are required' } }); const now = new Date().toISOString(); await store.update((next) => { if (next.promptRules.some((rule) => rule.modelId === body.modelId)) throw Object.assign(new Error('A rule for this model already exists'), { statusCode: 409 }); next.promptRules.push({ id: crypto.randomUUID(), modelId: body.modelId, prompt: body.prompt, enabled: body.enabled !== false, createdAt: now, updatedAt: now, hits: 0 }); return next; }); return sendJson(res, 201, publicState(store.snapshot())); }
  const match = url.pathname.match(/^\/admin\/api\/prompts\/([^/]+)$/);
  if (match) return promptApi(req, res, decodeURIComponent(match[1]));
  return sendJson(res, 404, { error: { message: 'Not found' } });
}

function validateUpstream(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw Object.assign(new Error('upstreamUrl must be a valid URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Object.assign(new Error('upstreamUrl must use HTTP(S) without embedded credentials'), { statusCode: 400 });
}
async function retryRuleApi(req, res, kind, id) {
  const key = kind === 'status' ? 'statusRules' : kind === 'code' ? 'codeRules' : 'messageRules';
  if (req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    if (kind === 'status') {
      const status = Number(body.status ?? body.value);
      if (!Number.isInteger(status) || status < 400 || status > 599) return sendJson(res, 400, { error: { message: 'status must be an integer between 400 and 599' } });
      await store.update((next) => { if (next.retry.statusRules.some((rule) => rule.status === status)) throw Object.assign(new Error('This status code already exists'), { statusCode: 409 }); next.retry.statusRules.push({ id: crypto.randomUUID(), status, enabled: body.enabled !== false }); return next; });
    } else {
      if (typeof body.value !== 'string' || !body.value.trim()) return sendJson(res, 400, { error: { message: 'value is required' } });
      await store.update((next) => { next.retry[key].push({ id: crypto.randomUUID(), value: body.value.trim(), mode: body.mode === 'substring-ci' ? 'substring-ci' : 'exact', enabled: body.enabled !== false }); return next; });
    }
    return sendJson(res, 201, publicState(store.snapshot()));
  }
  if (!id) return sendJson(res, 400, { error: { message: 'rule id is required' } });
  if (req.method === 'DELETE') { await store.update((next) => { next.retry[key] = next.retry[key].filter((rule) => rule.id !== id); return next; }); return sendJson(res, 200, publicState(store.snapshot())); }
  if (req.method === 'PUT') {
    const body = await readJson(req, 16 * 1024);
    await store.update((next) => {
      const rule = next.retry[key].find((item) => item.id === id); if (!rule) throw Object.assign(new Error('Rule not found'), { statusCode: 404 });
      if (kind === 'status') { const status = Number(body.status ?? body.value ?? rule.status); if (!Number.isInteger(status) || status < 400 || status > 599) throw Object.assign(new Error('status must be an integer between 400 and 599'), { statusCode: 400 }); if (next.retry.statusRules.some((item) => item.id !== id && item.status === status)) throw Object.assign(new Error('This status code already exists'), { statusCode: 409 }); rule.status = status; }
      else { if (body.value !== undefined) rule.value = String(body.value).trim(); if (body.mode !== undefined) rule.mode = body.mode === 'substring-ci' ? 'substring-ci' : 'exact'; }
      if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled); return next;
    });
    return sendJson(res, 200, publicState(store.snapshot()));
  }
  return sendJson(res, 405, { error: { message: 'Method not allowed' } });
}

async function promptApi(req, res, id) {
  if (req.method === 'DELETE') { await store.update((next) => { next.promptRules = next.promptRules.filter((rule) => rule.id !== id); return next; }); return sendJson(res, 200, publicState(store.snapshot())); }
  if (req.method === 'PUT') { const body = await readJson(req, 128 * 1024); await store.update((next) => { const rule = next.promptRules.find((item) => item.id === id); if (!rule) throw Object.assign(new Error('Rule not found'), { statusCode: 404 }); if (body.modelId !== undefined) { if (next.promptRules.some((item) => item.id !== id && item.modelId === body.modelId)) throw Object.assign(new Error('A rule for this model already exists'), { statusCode: 409 }); rule.modelId = body.modelId; } if (body.prompt !== undefined) rule.prompt = body.prompt; if (body.enabled !== undefined) rule.enabled = Boolean(body.enabled); rule.updatedAt = new Date().toISOString(); return next; }); return sendJson(res, 200, publicState(store.snapshot())); }
  return sendJson(res, 405, { error: { message: 'Method not allowed' } });
}
function publicState(config) { return { ...config, logs: recentLogs.slice(-100), promptRules: config.promptRules.map(({ prompt, ...rule }) => ({ ...rule, prompt, promptLength: prompt.length })) }; }
async function readJson(req, max) { const chunks = []; let total = 0; for await (const chunk of req) { total += chunk.length; if (total > max) throw Object.assign(new Error('Payload too large'), { statusCode: 413 }); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); } }
async function serveStatic(res, relative) { const safe = path.basename(relative); const file = path.join(publicDir, safe); try { const body = await fs.readFile(file); res.writeHead(200, { 'content-type': safe.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'content-length': body.length }); res.end(body); } catch { sendJson(res, 404, { error: { message: 'Not found' } }); } }
