import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { detectProtocol, findPromptRule, injectPrompt } from './protocols/prompt-injection.js';
import { copyForwardHeaders, isJsonContentType, isResponsesCreate, isStatusRetryEndpoint, readRequestBody, safeError, waitForAbort, pipeWithAbort, sendJson } from './http-utils.js';
import { executeResponseRequest } from './retry/responses-retry.js';
import { ResponsesSseCompatibility } from './protocols/responses-sse-compat.js';

export async function handleProxy(req, res, { store, logger, limits, debugCapture }) {
  const started = Date.now(); const controller = new AbortController(); waitForAbort(req, controller);
  const pathname = new URL(req.url, 'http://gateway').pathname;
  const debugId = debugCapture?.begin(req.method, pathname);
  const onBody = debugId ? (chunk) => debugCapture.writeResponse(debugId, chunk) : undefined;
  const onHeaders = debugId ? (status, headers) => debugCapture.startResponse(debugId, status, headers, 'upstream') : undefined;
  if (debugId) res.once('finish', () => debugCapture.finish(debugId, 'complete'));
  res.once('close', () => {
    if (res.writableFinished) return;
    if (debugId) debugCapture.finish(debugId, 'interrupted');
    controller.abort();
  });
  const config = store.snapshot();
  try {
    const body = await readRequestBody(req, limits.maxRequestBodyBytes);
    const parsed = parseJson(body);
    const protocol = req.method === 'POST' ? detectProtocol(pathname) : null;
    const rule = protocol && findPromptRule(config, parsed?.model); let forwardedBody = body; let promptHit = false;
    if (rule && (!req.headers['content-type'] || isJsonContentType(req.headers['content-type']))) {
      const injected = injectPrompt(body, protocol, rule); if (injected.changed) { forwardedBody = injected.body; promptHit = true; await store.update((next) => { const target = next.promptRules.find((item) => item.id === rule.id); if (target) target.hits = (target.hits || 0) + 1; next.metrics.promptHits = (next.metrics.promptHits || 0) + 1; }); }
    }
    await store.incrementMetric('requests');
    const target = buildTarget(config.upstreamUrl, req.url); const headers = copyForwardHeaders(req.headers); if (forwardedBody.length) headers['content-length'] = String(forwardedBody.length); else delete headers['content-length'];
    const responses = isResponsesCreate(req);
    const requestInfo = { stream: parsed?.stream === true, inspectStreamErrors: responses, body: forwardedBody, method: req.method, headers, target };
    const sendStream = (response, prefix, rest, signal, iterator) => sendStreamResponse(res, response, prefix, rest, signal, iterator, onHeaders, onBody, responses && requestInfo.stream ? parsed?.model : null);
    const canRetry = config.retry.enabled && (responses || (isStatusRetryEndpoint(req) && config.retry.statusRules?.some((rule) => rule.enabled)));
    const upstream = (signal = controller.signal) => {
      if (debugId && !signal.aborted) debugCapture.forward(debugId, requestInfo.body, requestInfo.headers);
      return requestUpstream({ ...requestInfo, signal, timeoutMs: canRetry ? config.retry.totalTimeoutMs : limits.requestTimeoutMs });
    };
    if (canRetry && requestInfo.stream) {
      await executeResponseRequest({ request: requestInfo, config: config.retry, upstream, clientSignal: controller.signal, maxResponseBodyBytes: limits.maxResponseBodyBytes, onRetry: (match, count) => { logger.info('responses retry', { path: '/v1/responses', attempt: count + 1, match: match.kind }); void store.incrementMetric('retries'); }, onSuccess: () => void store.incrementMetric('retrySuccesses'), onExhausted: () => void store.incrementMetric('retryExhausted'), sendStream });
      logger.info('proxy request', { method: req.method, path: pathname, status: res.statusCode || 200, attempts: 'retry-managed', promptHit, durationMs: Date.now() - started });
      return;
    }
    if (canRetry && !requestInfo.stream) {
      const outcome = await executeResponseRequest({ request: requestInfo, config: config.retry, upstream, clientSignal: controller.signal, maxResponseBodyBytes: limits.maxResponseBodyBytes, onRetry: (match, count) => { logger.info('responses retry', { path: '/v1/responses', attempt: count + 1, match: match.kind }); void store.incrementMetric('retries'); }, onSuccess: () => void store.incrementMetric('retrySuccesses'), onExhausted: () => void store.incrementMetric('retryExhausted'), sendStream: async () => {} });
      writeResponseHeaders(res, outcome.response, onHeaders); onBody?.(outcome.body); res.end(outcome.body); logger.info('proxy request', { method: req.method, path: pathname, status: outcome.response.statusCode, attempts: outcome.retryCount + 1, promptHit, durationMs: Date.now() - started }); return;
    }
    const response = await upstream(); await sendStream(response, [], null, controller.signal);
    logger.info('proxy request', { method: req.method, path: pathname, status: response.statusCode, attempts: 1, promptHit, durationMs: Date.now() - started });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const status = error.statusCode || (error.name === 'AbortError' ? 504 : 502);
    if (!res.headersSent) {
      if (debugId) debugCapture.startResponse(debugId, status, { 'content-type': 'application/json' }, 'gateway');
      sendJson(res, status, { error: { message: status === 502 ? 'Upstream request failed' : status === 504 ? 'Upstream timeout' : error.message } }, onBody);
    } else res.destroy();
    logger.warn('proxy error', { method: req.method, path: pathname, status, reason: safeError(error), durationMs: Date.now() - started });
  }
}

function parseJson(body) { try { return JSON.parse(body.toString('utf8')); } catch { return null; } }
export function buildTarget(upstreamBase, clientUrl) { const base = new URL(upstreamBase); const incoming = new URL(clientUrl, 'http://gateway'); const prefix = base.pathname.replace(/\/+$/, ''); const suffix = incoming.pathname.replace(/^\/+/, ''); const pathname = `${prefix}/${suffix}`.replace(/\/+/g, '/') || '/'; return new URL(`${pathname}${incoming.search}`, base.origin); }
function requestUpstream({ target, method, headers, body, signal, timeoutMs }) { return new Promise((resolve, reject) => { const client = target.protocol === 'https:' ? https : http; const request = client.request(target, { method, headers, signal, timeout: timeoutMs }, (response) => resolve(response)); request.once('error', reject); request.once('timeout', () => request.destroy(Object.assign(new Error('Upstream timeout'), { statusCode: 504 }))); if (body.length) request.write(body); request.end(); }); }
const REWRITTEN_BODY_HEADERS = new Set(['content-length', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'etag']);

function writeResponseHeaders(res, response, onHeaders, rewritten = false) {
  const headers = {}; const status = response.statusCode || 502;
  const connectionTokens = new Set(String(response.headers.connection || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  for (const [key, value] of Object.entries(response.headers)) {
    const lower = key.toLowerCase();
    if (!['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(lower) && !connectionTokens.has(lower) && !(rewritten && REWRITTEN_BODY_HEADERS.has(lower))) headers[key] = value;
  }
  res.writeHead(status, headers); onHeaders?.(status, headers);
}

async function sendStreamResponse(res, response, prefix, rest, signal, iterator, onHeaders, onBody, model) {
  const { statusCode, headers } = response;
  const encoding = String(headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const transform = typeof model === 'string' && model.trim() && statusCode >= 200 && statusCode < 300 && statusCode !== 206 && !headers['content-range'] &&
    (!encoding || encoding === 'identity') && /^text\/event-stream(?:\s*;|\s*$)/i.test(String(headers['content-type'] || ''))
    ? new ResponsesSseCompatibility(model) : null;
  writeResponseHeaders(res, response, onHeaders, Boolean(transform));
  for (const chunk of rest?.length ? [...prefix, rest] : prefix) {
    signal.throwIfAborted();
    const output = transform ? transform.transform(chunk) : chunk;
    if (!output.length) continue;
    onBody?.(output);
    if (!res.write(output)) await once(res, 'drain', { signal });
  }
  const iterable = iterator ? { [Symbol.asyncIterator]: () => iterator, destroy: () => response.destroy() } : response;
  await pipeWithAbort(iterable, res, signal, onBody, transform);
}
