import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesSseCompatibility } from '../src/protocols/responses-sse-compat.js';

const frame = (value, ending = '\n\n') => Buffer.from(`event: ${value.type}\ndata: ${JSON.stringify(value)}${ending}`);

test('repairs response.created model across split SSE chunks and preserves existing model', () => {
  const compat = new ResponsesSseCompatibility('gpt-test');
  const first = frame({ type: 'response.created', response: { id: 'r1', status: 'in_progress' }, sequence_number: 1 });
  const second = frame({ type: 'response.in_progress', response: { id: 'r1', model: 'native', status: 'in_progress' }, sequence_number: 2 });
  const all = Buffer.concat([compat.transform(first.subarray(0, 17)), compat.transform(Buffer.concat([first.subarray(17), second])), compat.flush()]).toString();
  assert.match(all, /"model":"gpt-test"/);
  assert.match(all, /"model":"native"/);
  assert.match(all, /"sequence_number":2/);
});

test('leaves non-target, comments, CRLF, DONE, and incomplete data unchanged', () => {
  const compat = new ResponsesSseCompatibility('gpt-test');
  const original = Buffer.from(': keep\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"hi"}\r\n\r\nevent: done\r\ndata: [DONE]\r\n\r\n');
  const result = Buffer.concat([compat.transform(original), compat.flush()]);
  assert.deepEqual(result, original);
  const incomplete = Buffer.from('event: response.created\ndata: {"type":"response.created","response":');
  const passthrough = new ResponsesSseCompatibility('gpt-test');
  assert.deepEqual(Buffer.concat([passthrough.transform(incomplete), passthrough.flush()]), incomplete);
});

test('without a request model the model fallback is transparent', () => {
  const body = frame({ type: 'response.created', response: { id: 'r1' } });
  const compat = new ResponsesSseCompatibility();
  assert.deepEqual(Buffer.concat([compat.transform(body), compat.flush()]), body);
});

test('adds completed status to function-call done items only when status is absent', () => {
  const compat = new ResponsesSseCompatibility('gpt-test');
  const original = { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', arguments: '{"location":"广州"}', call_id: 'call_1', name: 'get_weather' }, sequence_number: 18 };
  const missing = frame(original, '\r\n\r\n');
  assert.deepEqual(compat.transform(missing.subarray(0, -1)), Buffer.alloc(0));
  assert.deepEqual(compat.transform(missing.subarray(-1)), frame({ ...original, item: { ...original.item, status: 'completed' } }, '\r\n\r\n'));

  for (const unchanged of [
    { ...original, item: { ...original.item, status: 'incomplete' } },
    { ...original, item: { type: 'message', id: 'msg_1' } },
    { ...original, type: 'response.output_item.added' },
  ]) {
    const raw = frame(unchanged);
    assert.deepEqual(compat.transform(raw), raw);
  }
  assert.deepEqual(compat.flush(), Buffer.alloc(0));
});