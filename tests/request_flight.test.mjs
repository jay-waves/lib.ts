import test from 'node:test';
import assert from 'node:assert/strict';
import { requestFlight } from '../shared/request-flight.mjs';

test('cancelling one subscriber preserves work; cancelling the last releases its key immediately', async () => {
  const pending = new Map(), a = new AbortController(), b = new AbortController();
  let signal, release, calls = 0;
  const work = value => { calls++; signal = value; return new Promise(done => { release = done; }); };
  const first = requestFlight(pending, 'doc', work, a.signal);
  const second = requestFlight(pending, 'doc', work, b.signal);
  const firstRejected = assert.rejects(first, { name: 'AbortError' });
  const secondRejected = assert.rejects(second, { name: 'AbortError' });
  await Promise.resolve();
  a.abort(); await firstRejected;
  assert.equal(signal.aborted, false);
  b.abort(); await secondRejected;
  assert.equal(signal.aborted, true);
  assert.equal(pending.size, 0);
  const replacement = requestFlight(pending, 'doc', () => 42);
  release('obsolete');
  assert.equal(await replacement, 42);
  assert.equal(calls, 1);
  assert.equal(pending.size, 0);
});

test('a remaining subscriber gets the result and already aborted requests do not start work', async () => {
  const pending = new Map(), controller = new AbortController();
  let release;
  const first = requestFlight(pending, 'doc', () => new Promise(done => { release = done; }), controller.signal);
  const second = requestFlight(pending, 'doc', () => assert.fail('duplicate work'));
  const rejected = assert.rejects(first, { name: 'AbortError' });
  await Promise.resolve(); controller.abort(); release('ok');
  await rejected; assert.equal(await second, 'ok');
  await assert.rejects(requestFlight(pending, 'doc', () => assert.fail('cancelled work'), controller.signal), { name: 'AbortError' });
});
