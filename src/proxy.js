import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { detectProtocol, findPromptRule, injectPrompt } from './protocols/prompt-injection.js';
import { copyForwardHeaders, isJsonContentType, isResponsesCreate, normalizePath, readRequestBody, safeError, waitForAbort, pipeWithAbort, sendJson } from './http-utils.js';
import { executeResponseRequest, responseHeaders } from './retry/responses-retry.js';

export async function handleProxy(req, res, { store, logger, limits }) {
  const started = Date.now(); const controller = new AbortController(); waitForAbort(req, controller);
  const config = store.snapshot();
  try {
    const body = await readRequestBody(req, limits.maxRequestBodyBytes);
    const parsed = parseJson(body); const pathname = new URL(req.url, 'http://gateway').pathname; const protocol = detectProtocol(pathname);
    const rule = protocol && findPromptRule(config, parsed?.model); let forwardedBody = body; let promptHit = false;
    if (rule && (!req.headers['content-type'] || isJsonContentType(req.headers['content-type']))) {
      const injected = injectPrompt(body, protocol, rule); if (injected.changed) { forwardedBody = injected.body; promptHit = true; await store.update((next) => { const target = next.promptRules.find((item) => item.id === rule.id); if (target) target.hits = (target.hits || 0) + 1; next.metrics.promptHits = (next.metrics.promptHits || 0) + 1; }); }
    }
    await store.incrementMetric('requests');
    const target = buildTarget(config.upstreamUrl, req.url); const headers = copyForwardHeaders(req.headers); if (forwardedBody.length) headers['content-length'] = String(forwardedBody.length); else delete headers['content-length'];
    const requestInfo = { stream: parsed?.stream === true, body: forwardedBody, method: req.method, headers, target };
    const canRetry = isResponsesCreate(req) && config.retry.enabled;
    const upstream = (signal = controller.signal) => requestUpstream({ ...requestInfo, signal, timeoutMs: canRetry ? config.retry.totalTimeoutMs : limits.requestTimeoutMs });
    if (canRetry && requestInfo.stream) {
      await executeResponseRequest({ request: requestInfo, config: config.retry, upstream, clientSignal: controller.signal, maxResponseBodyBytes: limits.maxResponseBodyBytes, onRetry: (match, count) => { logger.info('responses retry', { path: '/v1/responses', attempt: count + 1, match: match.kind }); void store.incrementMetric('retries'); }, onSuccess: () => void store.incrementMetric('retrySuccesses'), onExhausted: () => void store.incrementMetric('retryExhausted'), sendStream: (response, prefix, rest, signal, iterator) => sendStreamResponse(res, response, prefix, rest, signal, iterator) });
      logger.info('proxy request', { method: req.method, path: pathname, status: res.statusCode || 200, attempts: 'retry-managed', promptHit, durationMs: Date.now() - started });
      return;
    }
    if (canRetry && !requestInfo.stream) {
      const outcome = await executeResponseRequest({ request: requestInfo, config: config.retry, upstream, clientSignal: controller.signal, maxResponseBodyBytes: limits.maxResponseBodyBytes, onRetry: (match, count) => { logger.info('responses retry', { path: '/v1/responses', attempt: count + 1, match: match.kind }); void store.incrementMetric('retries'); }, onSuccess: () => void store.incrementMetric('retrySuccesses'), onExhausted: () => void store.incrementMetric('retryExhausted'), sendStream: async () => {} });
      writeResponseHeaders(res, outcome.response); res.end(outcome.body); logger.info('proxy request', { method: req.method, path: pathname, status: outcome.response.statusCode, attempts: outcome.retryCount + 1, promptHit, durationMs: Date.now() - started }); return;
    }
    const response = await upstream(); writeResponseHeaders(res, response); await pipeWithAbort(response, res, controller.signal);
    logger.info('proxy request', { method: req.method, path: pathname, status: response.statusCode, attempts: 1, promptHit, durationMs: Date.now() - started });
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError' || res.destroyed) return;
    const status = error.statusCode || 502; if (!res.headersSent) sendJson(res, status, { error: { message: status === 502 ? 'Upstream request failed' : error.message } }); else res.destroy();
    logger.warn('proxy error', { method: req.method, path: new URL(req.url, 'http://gateway').pathname, status, reason: safeError(error), durationMs: Date.now() - started });
  }
}

function parseJson(body) { try { return JSON.parse(body.toString('utf8')); } catch { return null; } }
export function buildTarget(upstreamBase, clientUrl) { const base = new URL(upstreamBase); const incoming = new URL(clientUrl, 'http://gateway'); const prefix = base.pathname.replace(/\/+$/, ''); const suffix = incoming.pathname.replace(/^\/+/, ''); const pathname = `${prefix}/${suffix}`.replace(/\/+/g, '/') || '/'; return new URL(`${pathname}${incoming.search}`, base.origin); }
function requestUpstream({ target, method, headers, body, signal, timeoutMs }) { return new Promise((resolve, reject) => { const client = target.protocol === 'https:' ? https : http; const request = client.request(target, { method, headers, signal, timeout: timeoutMs }, (response) => resolve(response)); request.once('error', reject); request.once('timeout', () => request.destroy(Object.assign(new Error('Upstream timeout'), { statusCode: 504 }))); if (body.length) request.write(body); request.end(); }); }
function writeResponseHeaders(res, response) { const headers = {}; const connectionTokens = new Set(String(response.headers.connection || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)); for (const [key, value] of Object.entries(response.headers)) { const lower = key.toLowerCase(); if (!['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(lower) && !connectionTokens.has(lower)) headers[key] = value; } res.writeHead(response.statusCode || 502, headers); }
async function sendStreamResponse(res, response, prefix, rest, signal, iterator) { writeResponseHeaders(res, response); for (const chunk of prefix) if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve)); if (rest?.length && !res.write(rest)) await new Promise((resolve) => res.once('drain', resolve)); const iterable = iterator ? { [Symbol.asyncIterator]: () => iterator } : response; await pipeWithAbort(iterable, res, signal); }
