const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const MODEL_EVENTS = new Set(['response.created', 'response.in_progress']);

export class ResponsesSseCompatibility {
  constructor(model, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.model = typeof model === 'string' && model.trim() ? model : null;
    this.maxFrameBytes = maxFrameBytes;
    this.pending = Buffer.alloc(0);
  }

  transform(chunk) {
    if (!this.model) return Buffer.from(chunk);
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const output = [];
    while (true) {
      const boundary = findBoundary(this.pending);
      if (boundary < 0) {
        if (this.pending.length > this.maxFrameBytes) {
          output.push(this.pending);
          this.pending = Buffer.alloc(0);
        }
        break;
      }
      output.push(repairFrame(this.pending.subarray(0, boundary), this.model));
      this.pending = this.pending.subarray(boundary);
    }
    return Buffer.concat(output);
  }

  flush() {
    const output = this.pending;
    this.pending = Buffer.alloc(0);
    return output;
  }
}

function findBoundary(buffer) {
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === 10 && buffer[i + 1] === 10) return i + 2;
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i + 4;
  }
  return -1;
}

function repairFrame(frame, model) {
  const text = frame.toString('utf8');
  const lines = [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n)/g)];
  const eventLine = lines.find(([, line]) => line.startsWith('event:'))?.[1] || '';
  const dataLine = lines.find(([, line]) => line.startsWith('data:'));
  if (!dataLine || (eventLine && !MODEL_EVENTS.has(eventLine.slice(6).trim()))) return frame;
  let event;
  try { event = JSON.parse(dataLine[1].slice(5).replace(/^ /, '')); } catch { return frame; }
  if (!MODEL_EVENTS.has(event?.type) || !event.response || typeof event.response !== 'object' || event.response.model != null) return frame;
  event.response.model = model;
  const match = dataLine[0];
  const replacement = `data: ${JSON.stringify(event)}${match[2]}`;
  return Buffer.from(text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length), 'utf8');
}
