import { SseParser } from './sse-parser.js';

export function extractResponsesError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.error, payload.response?.error, payload.response?.response?.error];
  for (const error of candidates) if (error && typeof error === 'object' && (typeof error.code === 'string' || typeof error.message === 'string')) return { code: error.code || '', message: error.message || '' };
  return null;
}
export function matchesStatus(statusCode, config) {
  const status = Number(statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) return null;
  const rule = (config.statusRules || []).find((item) => item.enabled && item.status === status);
  return rule ? { kind: 'status', rule } : null;
}
export function matchesRetry(error, config) {
  if (!error) return null;
  for (const rule of [...(config.codeRules || [])]) if (rule.enabled && matchesRule(error.code, rule)) return { kind: 'code', rule };
  for (const rule of [...(config.messageRules || [])]) if (rule.enabled && matchesRule(error.message, rule)) return { kind: 'message', rule };
  return null;
}
function matchesRule(value, rule) { if (typeof value !== 'string') return false; return rule.mode === 'substring-ci' ? value.toLocaleLowerCase().includes(rule.value.toLocaleLowerCase()) : value === rule.value; }
export function eventError(event) { const error = extractResponsesError(event.json); if (error) return error; if (event.type === 'error' && event.json && typeof event.json === 'object') return extractResponsesError({ error: event.json.error || event.json }); return null; }
export function isTerminal(event) { return ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type) || event.data === '[DONE]'; }
export function isSubstantive(event) {
  if (!event?.type || !event.type.startsWith('response.')) return false;
  return !['response.created', 'response.queued', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed'].includes(event.type);
}
export function backoffDelay(config, retryIndex) { const raw = config.exponentialBackoff ? config.baseDelayMs * (2 ** Math.max(0, retryIndex - 1)) : config.baseDelayMs; return Math.min(config.maxDelayMs, raw); }
export async function retryDelay(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })); }; signal?.addEventListener('abort', abort, { once: true }); });
}

export async function executeResponseRequest({ request, config, upstream, clientSignal, maxResponseBodyBytes = 32 * 1024 * 1024, onRetry = () => {}, onSuccess = () => {}, onExhausted = () => {}, sendStream }) {
  const started = Date.now(); let retryCount = 0;
  while (true) {
    if (clientSignal.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const remaining = config.totalTimeoutMs - (Date.now() - started);
    if (remaining <= 0) throw Object.assign(new Error('Responses retry deadline exceeded'), { statusCode: 504 });
    const attempt = createAttemptSignal(clientSignal, remaining);
    try {
      const response = await upstream(attempt.signal); const stream = Boolean(request.stream);
      if (!stream) {
        const result = await readResponse(response, maxResponseBodyBytes, attempt.signal); const error = parseResponseError(response.statusCode, result.body); const match = matchesStatus(response.statusCode, config) || (request.inspectStreamErrors !== false ? matchesRetry(error, config) : null); const delay = match ? backoffDelay(config, retryCount + 1) : 0;
        if (match && retryCount < config.maxRetries && withinDeadline(started, config.totalTimeoutMs) && delay < (config.totalTimeoutMs - (Date.now() - started))) { retryCount++; onRetry(match, retryCount); await retryDelay(delay, clientSignal); continue; }
        if (match && (retryCount >= config.maxRetries || !withinDeadline(started, config.totalTimeoutMs))) onExhausted(); else if (retryCount) onSuccess();
        return { response, body: result.body, retryCount };
      }
      if (request.inspectStreamErrors === false) {
        const statusMatch = matchesStatus(response.statusCode, config);
        if (statusMatch && retryCount < config.maxRetries && withinDeadline(started, config.totalTimeoutMs) && backoffDelay(config, retryCount + 1) < (config.totalTimeoutMs - (Date.now() - started))) {
          response.destroy(); retryCount++; onRetry(statusMatch, retryCount); await retryDelay(backoffDelay(config, retryCount), clientSignal); continue;
        }
        if (statusMatch && retryCount >= config.maxRetries) onExhausted(); else if (retryCount) onSuccess();
        await sendStream(response, [], null, attempt.signal, response[Symbol.asyncIterator]());
        return { retryCount };
      }
      const statusMatch = matchesStatus(response.statusCode, config);
      if (statusMatch && retryCount < config.maxRetries && withinDeadline(started, config.totalTimeoutMs) && backoffDelay(config, retryCount + 1) < (config.totalTimeoutMs - (Date.now() - started))) {
        response.destroy(); retryCount++; onRetry(statusMatch, retryCount); await retryDelay(backoffDelay(config, retryCount), clientSignal); continue;
      }
      const outcome = await handleStreamAttempt(response, config, attempt.signal, started, retryCount, statusMatch, request.inspectStreamErrors !== false);
      if (outcome.retry) { retryCount++; onRetry(outcome.match, retryCount); await retryDelay(backoffDelay(config, retryCount), clientSignal); continue; }
      if ((outcome.match || statusMatch) && retryCount >= config.maxRetries) onExhausted(); else if (retryCount) onSuccess();
      await sendStream(outcome.response, outcome.prefix, outcome.rest, attempt.signal, outcome.iterator);
      return { retryCount };
    } finally { attempt.dispose(); }
  }
}
function createAttemptSignal(parent, timeoutMs) {
  const controller = new AbortController(); const abort = () => controller.abort();
  if (parent.aborted) controller.abort(); else parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent.removeEventListener('abort', abort); } };
}
async function readResponse(response, maxBytes, signal) { const chunks = []; let total = 0; const abort = () => response.destroy?.(Object.assign(new Error('Upstream request timed out'), { name: 'AbortError' })); signal?.addEventListener('abort', abort, { once: true }); try { for await (const chunk of response) { total += chunk.length; if (total > maxBytes) throw Object.assign(new Error('Upstream response too large'), { statusCode: 502 }); chunks.push(chunk); } return { body: Buffer.concat(chunks) }; } finally { signal?.removeEventListener('abort', abort); } }
function parseResponseError(statusCode, body) { try { const json = JSON.parse(body.toString('utf8')); return extractResponsesError(json); } catch { return null; } }
function withinDeadline(started, timeout) { return Date.now() - started < timeout; }

async function handleStreamAttempt(response, config, signal, started, retryCount, initialMatch = null, allowErrorRules = true) {
  const parser = new SseParser(); const prefix = []; let prefixBytes = 0; let passthrough = false; let matched = initialMatch;
  const iterator = response[Symbol.asyncIterator]();
  const abortResponse = () => response.destroy?.(Object.assign(new Error('Upstream request aborted'), { name: 'AbortError' }));
  signal.addEventListener('abort', abortResponse, { once: true });
  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => { timeoutHandle = setTimeout(() => resolve({ timedOut: true }), Math.min(config.preflightMs, Math.max(1, config.totalTimeoutMs - (Date.now() - started)))); });
  let pendingNext = nextIteratorValue(iterator);
  try {
    while (true) {
      const result = await Promise.race([pendingNext, timeoutPromise]);
      if (result.timedOut) return { retry: false, response, prefix, rest: parser.takePending(), iterator: handoffIterator(pendingNext, iterator), match: matched };
      if (result.error) throw result.error;
      const next = result.value;
      if (next.done) break;
      pendingNext = nextIteratorValue(iterator);
      const chunk = Buffer.from(next.value);
      if (passthrough) return { retry: false, response, prefix, rest: Buffer.concat([parser.takePending(), chunk]), iterator: handoffIterator(pendingNext, iterator), match: matched };
      const events = parser.feed(chunk);
      for (const event of events) {
        prefix.push(event.raw); prefixBytes += event.raw.length;
        const error = eventError(event); const candidate = allowErrorRules ? matchesRetry(error, config) : null;
        if (candidate && !passthrough && !isSubstantive(event) && retryCount < config.maxRetries && withinDeadline(started, config.totalTimeoutMs) && backoffDelay(config, retryCount + 1) < (config.totalTimeoutMs - (Date.now() - started))) { response.destroy(); return { retry: true, match: candidate }; }
        if (error && candidate) matched = candidate;
        if (isSubstantive(event) || isTerminal(event) || prefixBytes >= config.preflightBytes) passthrough = true;
      }
      if (passthrough || prefixBytes >= config.preflightBytes) return { retry: false, response, prefix, rest: parser.takePending(), iterator: handoffIterator(pendingNext, iterator), match: matched };
    }
    if (!passthrough) {
      for (const event of parser.finish()) {
        prefix.push(event.raw); prefixBytes += event.raw.length;
        const error = eventError(event); const candidate = allowErrorRules ? matchesRetry(error, config) : null;
        if (candidate && !passthrough && !isSubstantive(event) && retryCount < config.maxRetries && withinDeadline(started, config.totalTimeoutMs) && backoffDelay(config, retryCount + 1) < (config.totalTimeoutMs - (Date.now() - started))) return { retry: true, match: candidate };
        if (error && candidate) matched = candidate;
        if (isSubstantive(event) || isTerminal(event)) passthrough = true;
      }
    }
  } finally { clearTimeout(timeoutHandle); signal.removeEventListener('abort', abortResponse); }
  return { retry: false, response, prefix, rest: Buffer.alloc(0), iterator, match: matched };
}

function nextIteratorValue(iterator) {
  return Promise.resolve().then(() => iterator.next()).then((value) => ({ value }), (error) => ({ error }));
}
function handoffIterator(first, iterator) {
  let pending = first;
  return { async next() { const result = await pending; if (result.error) throw result.error; pending = nextIteratorValue(iterator); return result.value; }, async return() { if (iterator.return) return iterator.return(); return { done: true }; }, [Symbol.asyncIterator]() { return this; } };
}

export function responseHeaders(response) { const headers = {}; for (const [key, value] of Object.entries(response.headers)) if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade'].includes(key.toLowerCase())) headers[key] = value; return headers; }
