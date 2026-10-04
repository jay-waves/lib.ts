import test from 'node:test';
import assert from 'node:assert/strict';
import { retainDocument } from '../library/document-session.mjs';

test('browser pages renew independently, release on exit and resume after bfcache', () => {
  const window = new EventTarget(), requests = [], timers = new Set();
  const options = client => ({ window, client,
    fetch: async (url, init) => { requests.push({ url, ...JSON.parse(init.body), keepalive: init.keepalive }); },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) });
  const stopA = retainDocument('/a/api', 'book.pdf', options('a'));
  const stopB = retainDocument('/a/api', 'book.pdf', options('b'));
  assert.deepEqual(requests.map(r => r.client), ['a', 'b']);
  for (const tick of timers) tick();
  assert.deepEqual(requests.slice(-2).map(r => r.version), [2, 2]);
  window.dispatchEvent(new Event('pagehide'));
  assert.ok(requests.slice(-2).every(r => r.paths.length === 0 && r.keepalive));
  const count = requests.length;
  for (const tick of timers) tick();
  assert.equal(requests.length, count);
  window.dispatchEvent(new Event('pageshow'));
  assert.ok(requests.slice(-2).every(r => r.paths[0] === 'book.pdf' && r.version === 4));
  stopA();
  for (const tick of timers) tick();
  assert.equal(requests.at(-1).client, 'b');
  stopB(); assert.equal(timers.size, 0);
});
