import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskQueue } from '../server/task-queue.mjs';

test('only the newest queued version runs, and obsolete running results can be discarded', async () => {
  const run = createTaskQueue(1, 1);
  let release;
  const first = run(async ({ assertCurrent }) => {
    await new Promise(done => { release = done; });
    assertCurrent();
  }, { key: 'document' });
  const firstRejected = assert.rejects(first, { code: 'SUPERSEDED' });
  await Promise.resolve();
  const old = run(() => assert.fail('obsolete version ran'), { key: 'document', bytes: 8 });
  const oldRejected = assert.rejects(old, { code: 'SUPERSEDED' });
  const newest = run(() => 'latest', { key: 'document', bytes: 10 });
  await oldRejected; release(); await firstRejected;
  assert.equal(await newest, 'latest');
});

test('byte admission accounts for replacements and cancellation releases waiting input', async () => {
  const run = createTaskQueue(1, 5, 10);
  let release;
  const active = run(() => new Promise(done => { release = done; }));
  const controller = new AbortController();
  const queued = run(() => assert.fail('aborted work ran'), { key: 'doc', bytes: 8, signal: controller.signal });
  const cancelled = assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(run(() => 0, { bytes: 3 }), /busy/);
  // An inadmissible replacement must not invalidate the admitted task.
  await assert.rejects(run(() => 0, { key: 'doc', bytes: 11 }), /busy/);
  controller.abort(); await cancelled;
  const replacement = run(() => 42, { bytes: 10 });
  release(); await active;
  assert.equal(await replacement, 42);
});

test('foreground requests precede prefetch and equal priorities preserve FIFO', async () => {
  const run = createTaskQueue(1), order = [];
  let release;
  const active = run(() => new Promise(done => { release = done; }));
  const background = run(() => order.push('background'), { key: 'background', priority: -1 });
  const secondBackground = run(() => order.push('second background'), { priority: -1 });
  const foreground = run(() => order.push('foreground'), { priority: 1 });
  await Promise.resolve(); release();
  await Promise.all([active, background, secondBackground, foreground]);
  assert.deepEqual(order, ['foreground', 'background', 'second background']);
});

test('native work has a concurrency and queue bound, then drains after failures', async () => {
  const run = createTaskQueue(2, 1);
  let active = 0, peak = 0;
  const releases = [];
  const work = () => new Promise(resolve => {
    peak = Math.max(peak, ++active);
    releases.push(() => { active--; resolve(); });
  });
  const first = run(work), second = run(work);
  const third = run(() => { throw new Error('native failure'); });
  const rejected = assert.rejects(third, /native failure/);
  await assert.rejects(run(work), /busy/);
  assert.equal(peak, 2);
  releases.shift()();
  await first; await rejected;
  releases.shift()(); await second;
  assert.equal(await run(() => 42), 42);
  assert.equal(active, 0);
});
