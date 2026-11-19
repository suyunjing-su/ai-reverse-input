import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { detectProtocol, findPromptRule, injectPrompt } from './protocols/prompt-injection.js';
import { copyForwardHeaders, isEventStream, isIdentityEncoding, isJsonContentType, isResponsesCreate, isStatusRetryEndpoint, readRequestBody, safeError, waitForAbort, pipeWithAbort, sendJson } from './http-utils.js';
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
    const model = responses && typeof parsed?.model === 'string' && parsed.model.trim() ? parsed.model : null;
    const sendStream = (response, prefix, rest, signal, iterator) => sendStreamResponse(res, response, prefix, rest, signal, iterator, onHeaders, onBody, model);
    const canRetry = config.retry.enabled && (responses || (isStatusRetryEndpoint(req) && config.retry.statusRules?.some((rule) => rule.enabled)));
    const upstream = async (signal = controller.signal) => {
      if (debugId && !signal.aborted) debugCapture.forward(debugId, requestInfo.body, requestInfo.headers);
      const response = await requestUpstream({ ...requestInfo, signal, timeoutMs: canRetry ? config.retry.totalTimeoutMs : limits.requestTimeoutMs, streamIdleTimeoutMs: responses ? limits.responsesStreamIdleTimeoutMs : undefined });
      return model && isRepairableSse(response) ? decodeSse(response) : response;
    };
    if (canRetry) {
      const outcome = await executeResponseRequest({ request: requestInfo, config: config.retry, upstream, clientSignal: controller.signal, maxResponseBodyBytes: limits.maxResponseBodyBytes, onRetry: (match, count) => { logger.info('responses retry', { path: pathname, attempt: count + 1, match: match.kind }); void store.incrementMetric('retries'); }, onSuccess: () => void store.incrementMetric('retrySuccesses'), onExhausted: () => void store.incrementMetric('retryExhausted'), sendStream });
      if (outcome.response) { writeResponseHeaders(res, outcome.response, onHeaders); onBody?.(outcome.body); res.end(outcome.body); }
      logger.info('proxy request', { method: req.method, path: pathname, status: res.statusCode, attempts: outcome.retryCount + 1, promptHit, durationMs: Date.now() - started });
      return;
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
function requestUpstream({ target, method, headers, body, signal, timeoutMs, streamIdleTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const timeoutError = () => Object.assign(new Error('Upstream timeout'), { statusCode: 504 });
    const request = client.request(target, { method, headers, signal, timeout: timeoutMs }, (response) => {
      if (streamIdleTimeoutMs && isEventStream(response.headers)) {
        request.removeListener('timeout', onRequestTimeout);
        response.setTimeout(streamIdleTimeoutMs, () => response.destroy(timeoutError()));
      }
      resolve(response);
    });
    const onRequestTimeout = () => request.destroy(timeoutError());
    request.once('error', reject);
    request.once('timeout', onRequestTimeout);
    if (body.length) request.write(body);
    request.end();
  });
}
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

function isRepairableSse({ statusCode, headers }) {
  return statusCode >= 200 && statusCode < 300 && statusCode !== 204 && statusCode !== 205 && statusCode !== 206 && !headers['content-range'] && isEventStream(headers);
}

function decodeSse(response) {
  const encoding = String(response.headers['content-encoding'] || '').trim().toLowerCase();
  const createDecoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip : encoding === 'br' ? createBrotliDecompress : encoding === 'deflate' ? createInflate : null;
  if (!createDecoder) return response;
  const decoded = createDecoder();
  const headers = { ...response.headers };
  delete headers['content-encoding']; delete headers['content-length']; delete headers.etag;
  // Propagate upstream errors to the decoder, and tear down upstream on abort.
  pipeline(response, decoded, () => {});
  decoded.statusCode = response.statusCode; decoded.headers = headers;
  return decoded;
}

async function* responseChunks(prefix, rest, iterator) {
  yield* prefix;
  if (rest?.length) yield rest;
  yield* { [Symbol.asyncIterator]: () => iterator };
}

async function sendStreamResponse(res, response, prefix, rest, signal, iterator, onHeaders, onBody, model) {
  signal.throwIfAborted();
  const transform = model && isRepairableSse(response) && isIdentityEncoding(response.headers) ? new ResponsesSseCompatibility(model) : null;
  writeResponseHeaders(res, response, onHeaders, Boolean(transform));
  const iterable = iterator ? {
    [Symbol.asyncIterator]: () => responseChunks(prefix, rest, iterator),
    destroy: () => response.destroy(),
  } : response;
  await pipeWithAbort(iterable, res, signal, onBody, transform);
}
