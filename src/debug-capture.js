import { randomUUID } from 'node:crypto';

const MAX_RECORDS = 20;
const MAX_BODY_BYTES = 256 * 1024;

function bodyCapture() {
  return { mediaType: '', contentEncoding: '', bytes: 0, stored: 0, buffer: null };
}

function describeBody(body, headers) {
  body.mediaType = String(headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase().slice(0, 128);
  body.contentEncoding = String(headers['content-encoding'] || '').trim().toLowerCase().slice(0, 128);
}

function collect(body, chunk, limit) {
  body.bytes += chunk.length;
  const count = Math.min(chunk.length, limit - body.stored);
  if (count <= 0) return;
  body.buffer ??= Buffer.alloc(limit);
  chunk.copy(body.buffer, body.stored, 0, count);
  body.stored += count;
}

function bodyPreview(body) {
  const { mediaType, contentEncoding, bytes, stored, buffer } = body;
  const text = (!contentEncoding || contentEncoding === 'identity') &&
    (!mediaType || /^(text\/|application\/(?:json$|[^/]+\+json$|xml$|[^/]+\+xml$|x-www-form-urlencoded$))/.test(mediaType));
  const data = buffer?.subarray(0, stored);
  return { mediaType, contentEncoding, bytes, stored, truncated: bytes > stored, encoding: text ? 'utf8' : 'base64', content: data?.toString(text ? 'utf8' : 'base64') ?? '' };
}

function summary({ request, response, ...record }) {
  return { ...record, requestBytes: request.bytes, responseBytes: response.bytes };
}

export class DebugCapture {
  #enabled = false;
  #records = new Map();
  #maxRecords;
  #maxBodyBytes;

  constructor({ maxRecords = MAX_RECORDS, maxBodyBytes = MAX_BODY_BYTES } = {}) {
    this.#maxRecords = maxRecords;
    this.#maxBodyBytes = maxBodyBytes;
  }

  setEnabled(enabled) {
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  clear() { this.#records.clear(); }

  list() {
    return { enabled: this.#enabled, maxRecords: this.#maxRecords, maxBodyBytes: this.#maxBodyBytes, records: [...this.#records.values()].reverse().map(summary) };
  }

  get(id) {
    const record = this.#records.get(id);
    if (!record) return null;
    return { ...summary(record), request: bodyPreview(record.request), response: bodyPreview(record.response) };
  }

  begin(method, pathname) {
    if (!this.#enabled) return null;
    if (this.#records.size >= this.#maxRecords) {
      for (const [id, record] of this.#records) {
        if (record.state === 'pending') continue;
        this.#records.delete(id);
        break;
      }
      if (this.#records.size >= this.#maxRecords) return null;
    }
    const id = randomUUID();
    this.#records.set(id, {
      id, method, pathname, startedAt: new Date().toISOString(), finishedAt: null, attempts: 0,
      state: 'pending', status: null, source: null, request: bodyCapture(), response: bodyCapture(),
    });
    return id;
  }

  forward(id, body, headers) {
    const record = this.#pending(id);
    if (!record || ++record.attempts !== 1) return;
    describeBody(record.request, headers);
    collect(record.request, body, this.#maxBodyBytes);
  }

  startResponse(id, status, headers, source) {
    const record = this.#pending(id);
    if (!record) return;
    record.status = status;
    record.source = source;
    describeBody(record.response, headers);
  }

  writeResponse(id, chunk) {
    const record = this.#pending(id);
    if (!record || !record.source || record.method === 'HEAD' || [204, 304].includes(record.status) || record.status < 200) return;
    collect(record.response, chunk, this.#maxBodyBytes);
  }

  finish(id, state) {
    const record = this.#pending(id);
    if (!record) return;
    record.state = state;
    record.finishedAt = new Date().toISOString();
  }

  #pending(id) {
    const record = this.#records.get(id);
    return record?.state === 'pending' ? record : null;
  }
}
