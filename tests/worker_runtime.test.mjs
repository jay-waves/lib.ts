import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkerRuntime, singleFlight } from '../server/worker-runtime.mjs';
import { serveWorker } from '../server/worker-host.mjs';
import { createWorkerClient } from '../server/worker-client.mjs';

test('runtime bounds queued work, retries exits only and rejects work after close', async () => {
  let stops = 0, release, attempts = 0;
  const worker = { running: false, stop: async () => { stops++; } };
  const runtime = createWorkerRuntime({ worker, name: 'Test', maxPending: 1 });
  const first = runtime.run(() => new Promise(done => { release = done; }));
  const queued = runtime.run(() => {
    if (++attempts === 1) throw Object.assign(new Error('exit'), { code: 'WORKER_EXIT' });
    return 42;
  });
  await assert.rejects(runtime.run(() => 0), /busy/);
  release();
  await first;
  assert.equal(await queued, 42);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(runtime.run(() => { attempts++; throw new Error('engine failure'); }), /engine failure/);
  assert.equal(attempts, 1);
  const blocked = runtime.run(() => new Promise(done => { release = done; }));
  const waiting = runtime.run(() => assert.fail('queued work ran after close'));
  const rejected = assert.rejects(waiting, /closed/);
  await Promise.resolve();
  await runtime.close();
  await runtime.close();
  release();
  await blocked;
  await rejected;
  assert.equal(stops, 1);
  await assert.rejects(runtime.run(() => 1), /closed/);
});

test('singleFlight coalesces calls and removes failed work for retry', async () => {
  const pending = new Map();
  let calls = 0;
  const work = () => { calls++; throw new Error('failure'); };
  const first = singleFlight(pending, 'key', work);
  assert.strictEqual(singleFlight(pending, 'key', work), first);
  await assert.rejects(first, /failure/);
  assert.equal(calls, 1);
  assert.equal(pending.size, 0);
  assert.equal(await singleFlight(pending, 'key', () => 42), 42);
  assert.equal(pending.size, 0);
});

test('worker host serializes methods, rejects inherited names and preserves transfer and error metadata', async () => {
  const port = new EventEmitter(), messages = [], order = [];
  let release;
  port.postMessage = (message, transfer) => { messages.push({ message, transfer }); port.emit('response'); };
  serveWorker({
    async first() { order.push('first'); await new Promise(done => { release = done; }); return { body: new ArrayBuffer(4) }; },
    second() { order.push('second'); throw Object.assign(new Error('changed'), { status: 410, code: 'REVISION' }); },
  }, { port, transfer: value => value?.body ? [value.body] : [] });
  port.emit('message', { id: 1, method: 'first' });
  port.emit('message', { id: 2, method: 'second' });
  port.emit('message', { id: 3, method: 'toString' });
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  release();
  await new Promise(done => {
    const check = () => { if (messages.length === 3) { port.off('response', check); done(); } };
    port.on('response', check); check();
  });
  assert.deepEqual(order, ['first', 'second']);
  assert.strictEqual(messages[0].transfer[0], messages[0].message.value.body);
  assert.equal(messages[1].message.status, 410);
  assert.equal(messages[1].message.code, 'REVISION');
  assert.match(messages[2].message.error, /Unknown worker method/);
});

test('uncloneable requests do not poison subsequent worker requests', async t => {
  const worker = createWorkerClient({ name: 'Test Markdown', url: new URL('../server/markdown/worker.mjs', import.meta.url) });
  t.after(() => worker.stop());
  await assert.rejects(worker.request('render', { source: () => {} }), /clone/i);
  assert.match(await worker.request('render', { source: '# Still works' }), /Still works/);
});
