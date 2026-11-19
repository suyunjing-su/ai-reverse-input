import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugCapture } from '../src/debug-capture.js';

test('debug capture is opt-in, bounded, and keeps each request and response separate', () => {
  const debug = new DebugCapture({ maxRecords: 2, maxBodyBytes: 4 });
  assert.equal(debug.begin('POST', '/disabled'), null);
  assert.equal(debug.list().enabled, false);
  debug.setEnabled(true);
  const a = debug.begin('POST', '/a');
  const b = debug.begin('POST', '/b');
  assert.equal(debug.begin('POST', '/overflow'), null);

  const json = { 'content-type': 'application/json; charset=utf-8', authorization: 'not captured' };
  debug.forward(a, Buffer.from('abcdef'), json);
  debug.forward(a, Buffer.from('retry'), json);
  debug.forward(b, Buffer.from('xyz'), json);
  debug.startResponse(a, 200, { 'content-type': 'text/event-stream' }, 'upstream');
  debug.startResponse(b, 200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, 'upstream');
  debug.writeResponse(a, Buffer.from('12'));
  debug.writeResponse(b, Buffer.from([0xff, 0x01]));
  debug.writeResponse(a, Buffer.from('3456'));
  debug.finish(a, 'complete');

  const first = debug.get(a);
  assert.equal(first.attempts, 2);
  assert.deepEqual(first.request, { mediaType: 'application/json', contentEncoding: '', bytes: 6, stored: 4, truncated: true, encoding: 'utf8', content: 'abcd' });
  assert.deepEqual(first.response, { mediaType: 'text/event-stream', contentEncoding: '', bytes: 6, stored: 4, truncated: true, encoding: 'utf8', content: '1234' });
  const second = debug.get(b);
  assert.equal(second.request.content, 'xyz');
  assert.equal(second.response.encoding, 'base64');
  assert.deepEqual(Buffer.from(second.response.content, 'base64'), Buffer.from([0xff, 0x01]));
  assert.equal(debug.list().records[0].request, undefined);
  assert.ok(debug.begin('GET', '/next'));
  assert.equal(debug.get(a), null);
  assert.equal(debug.get(b).state, 'pending');
});

test('cleared and disabled records cannot be populated by old in-flight requests', () => {
  const debug = new DebugCapture();
  debug.setEnabled(true);
  const cleared = debug.begin('POST', '/cleared');
  debug.clear();
  assert.equal(debug.list().enabled, true);
  const disabled = debug.begin('POST', '/disabled');
  debug.setEnabled(false);
  debug.setEnabled(true);
  const fresh = debug.begin('HEAD', '/fresh');
  for (const id of [cleared, disabled]) {
    debug.forward(id, Buffer.from('stale'), {});
    debug.startResponse(id, 200, {}, 'upstream');
    debug.writeResponse(id, Buffer.from('stale'));
    debug.finish(id, 'complete');
    assert.equal(debug.get(id), null);
  }
  debug.startResponse(fresh, 200, {}, 'upstream');
  debug.writeResponse(fresh, Buffer.from('no HEAD body'));
  debug.finish(fresh, 'complete');
  assert.equal(debug.get(fresh).response.bytes, 0);
  assert.deepEqual(debug.list().records.map(({ id }) => id), [fresh]);
});
