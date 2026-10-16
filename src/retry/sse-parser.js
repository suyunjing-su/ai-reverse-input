import { Buffer } from 'node:buffer';

export class SseParser {
  constructor() { this.pending = Buffer.alloc(0); this.eventLines = []; this.eventBytes = []; }
  feed(chunk) {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const events = [];
    while (true) {
      const line = findLine(this.pending);
      if (!line) break;
      this.pending = this.pending.subarray(line.bytes);
      const content = line.content.toString('utf8');
      if (content === '') { if (this.eventBytes.length) this.eventBytes.push(line.raw); const event = this.finishEvent(); if (event) events.push(event); }
      else if (!content.startsWith(':')) { this.eventLines.push(content); this.eventBytes.push(line.raw); }
      else this.eventBytes.push(line.raw);
    }
    return events;
  }
  takePending() { const value = this.pending; this.pending = Buffer.alloc(0); return value; }
  finish() {
    const events = []; const event = this.finishEvent(); if (event) events.push(event);
    if (this.pending.length) events.push({ raw: this.pending, event: '', data: '', type: '', json: null, incomplete: true });
    this.pending = Buffer.alloc(0); return events;
  }
  finishEvent() {
    if (!this.eventBytes.length && !this.eventLines.length) return null;
    const raw = Buffer.concat(this.eventBytes); const fields = { event: '', data: [], id: '', retry: '' };
    for (const line of this.eventLines) {
      const index = line.indexOf(':'); const name = index < 0 ? line : line.slice(0, index);
      let value = index < 0 ? '' : line.slice(index + 1); if (value.startsWith(' ')) value = value.slice(1);
      if (name === 'data') fields.data.push(value); else if (name === 'event' || name === 'id' || name === 'retry') fields[name] = value;
    }
    const data = fields.data.join('\n'); let json = null;
    if (data && data !== '[DONE]') { try { json = JSON.parse(data); } catch {} }
    const result = { raw, event: fields.event, data, id: fields.id, retry: fields.retry, type: json?.type || fields.event || '', json };
    this.eventLines = []; this.eventBytes = []; return result;
  }
}
function findLine(buffer) {
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 10) { const hasCr = i > 0 && buffer[i - 1] === 13; const end = hasCr ? i - 1 : i; return { content: buffer.subarray(0, end), raw: buffer.subarray(0, i + 1), bytes: i + 1 }; }
    if (buffer[i] === 13) {
      if (i + 1 >= buffer.length) return null;
      if (buffer[i + 1] === 10) return { content: buffer.subarray(0, i), raw: buffer.subarray(0, i + 2), bytes: i + 2 };
      return { content: buffer.subarray(0, i), raw: buffer.subarray(0, i + 1), bytes: i + 1 };
    }
  }
  return null;
}
