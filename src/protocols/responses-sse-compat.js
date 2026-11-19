const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const MODEL_EVENTS = new Set(['response.created', 'response.in_progress']);
const OUTPUT_ITEM_DONE = 'response.output_item.done';
const utf8 = new TextDecoder('utf-8', { fatal: true });

export class ResponsesSseCompatibility {
  #parts = [];
  #size = 0;
  #lineHasData = false;
  #pendingCR = false;
  #blankCR = false;
  #oversized = false;

  constructor(model, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.model = typeof model === 'string' && model.trim() ? model : null;
    this.maxFrameBytes = maxFrameBytes;
  }

  transform(chunk) {
    if (!this.model) return chunk;
    const output = [];
    let start = 0;
    const finish = (end) => {
      this.#append(chunk.subarray(start, end), output);
      if (!this.#oversized) output.push(repairFrame(Buffer.concat(this.#parts, this.#size), this.model));
      this.#parts = [];
      this.#size = 0;
      this.#oversized = false;
      start = end;
    };
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (this.#pendingCR) {
        this.#pendingCR = false;
        if (this.#blankCR) finish(i + (byte === 10 ? 1 : 0));
        if (byte === 10) continue;
      }
      if (byte === 13) {
        this.#pendingCR = true;
        this.#blankCR = !this.#lineHasData;
        this.#lineHasData = false;
      } else if (byte === 10) {
        if (!this.#lineHasData) finish(i + 1);
        this.#lineHasData = false;
      } else {
        this.#lineHasData = true;
      }
    }
    this.#append(chunk.subarray(start), output);
    return output.length === 1 ? output[0] : Buffer.concat(output);
  }

  flush() {
    const raw = Buffer.concat(this.#parts, this.#size);
    this.#parts = [];
    this.#size = 0;
    return this.#pendingCR && this.#blankCR && !this.#oversized ? repairFrame(raw, this.model) : raw;
  }

  #append(part, output) {
    if (!part.length) return;
    if (this.#oversized || this.#size + part.length > this.maxFrameBytes) {
      for (const prior of this.#parts) output.push(prior);
      output.push(part);
      this.#parts = [];
      this.#size = 0;
      this.#oversized = true;
    } else {
      this.#parts.push(Buffer.from(part));
      this.#size += part.length;
    }
  }
}

function repairFrame(frame, model) {
  // Latin-1 maps one character to one byte, so non-data fields stay byte-exact.
  const wire = frame.toString('latin1');
  const data = [];
  for (const match of wire.matchAll(/([^\r\n]*)(\r\n|\r|\n)/g)) {
    const line = match[1];
    if (line === 'data' || line.startsWith('data:')) data.push({ match, value: line.slice(5).replace(/^ /, '') });
  }
  if (!data.length) return frame;
  let event;
  try { event = JSON.parse(utf8.decode(Buffer.from(data.map(({ value }) => value).join('\n'), 'latin1'))); } catch { return frame; }
  if (!repairEvent(event, model)) return frame;
  const output = [];
  let offset = 0;
  for (const [index, { match }] of data.entries()) {
    output.push(frame.subarray(offset, match.index));
    // Keep each terminator: deleting a data line can merge a bare CR and LF
    // into one CRLF, removing the blank line that dispatches the event.
    output.push(Buffer.from(`${index === 0 ? `data: ${JSON.stringify(event)}` : 'data:'}${match[2]}`));
    offset = match.index + match[0].length;
  }
  output.push(frame.subarray(offset));
  return Buffer.concat(output);
}

function repairEvent(event, model) {
  const response = event?.response;
  if (MODEL_EVENTS.has(event?.type) && response && typeof response === 'object' && !Array.isArray(response) && response.model == null) {
    response.model = model;
    return true;
  }
  const item = event?.item;
  if (event?.type === OUTPUT_ITEM_DONE && item?.type === 'function_call' && item.status === undefined) {
    item.status = 'completed';
    return true;
  }
  return false;
}
