import test from 'node:test';
import assert from 'node:assert/strict';
import { createGalleryPlaybackQueue, createGalleryPreviewCache, startGalleryPlayback, galleryPlaybackWeight, galleryPlaybackTurn } from './gallery-playback.mjs';

function schedulerClock() {
  const tasks = new Map();
  let sequence = 0;
  return {
    tasks,
    setTimeout(fn, delay) { tasks.set(++sequence, { fn, delay }); return sequence; },
    clearTimeout(id) { tasks.delete(id); },
    tick(delay = galleryPlaybackTurn) {
      const task = [...tasks].find(([, value]) => value.delay === delay);
      assert.ok(task, `expected ${delay}ms timer`);
      tasks.delete(task[0]);
      task[1].fn();
    },
  };
}

function fixture(play = () => new Promise(() => {}), queue, page, dimensions = { width: 1280, height: 720 }) {
  const timers = schedulerClock();
  const video = Object.assign(new EventTarget(), {
    src: '', pauses: 0, loads: 0, plays: 0,
    play() { this.plays++; return play(); },
    pause() { this.pauses++; },
    load() { this.loads++; },
    removeAttribute() { this.src = ''; },
    getAttribute() { return this.src || null; },
  });
  const ready = [];
  let errors = 0;
  const stop = startGalleryPlayback(video, '/clip', {
    onReady: value => ready.push(value), onError: () => errors++, queue, page, dimensions,
  }, timers);
  return { video, ready, tasks: timers.tasks, stop, tick: timers.tick, errors: () => errors };
}

test('pending play times out, releases the source and retries only once', () => {
  const f = fixture();
  assert.equal(f.video.muted, true);
  f.tick(60000);
  assert.equal(f.video.src, '');
  assert.equal(f.video.pauses, 1);
  f.tick(500);
  assert.equal(f.video.plays, 2);
  f.tick(60000);
  assert.equal(f.errors(), 1);
  assert.equal(f.tasks.size, 0);
  f.stop();
});

test('playing clears startup timeout; buffering has its own watchdog', () => {
  const f = fixture();
  f.video.dispatchEvent(new Event('playing'));
  assert.deepEqual(f.ready, [true]);
  assert.equal(f.tasks.size, 0);
  f.video.dispatchEvent(new Event('waiting'));
  f.video.dispatchEvent(new Event('waiting'));
  assert.equal(f.tasks.size, 1);
  f.video.dispatchEvent(new Event('playing'));
  assert.equal(f.tasks.size, 0);
  f.stop();
  assert.equal(f.video.src, '');
  assert.equal(f.video.loads, 1);
});

test('leaving cancels retries and ignores late play rejection', async () => {
  let reject;
  const f = fixture(() => new Promise((_, fail) => { reject = fail; }));
  f.stop();
  reject(new Error('aborted'));
  await Promise.resolve();
  assert.equal(f.tasks.size, 0);
  assert.equal(f.errors(), 0);
  assert.equal(f.video.src, '');
  const retrying = fixture();
  retrying.video.dispatchEvent(new Event('error'));
  retrying.stop();
  assert.equal(retrying.tasks.size, 0);
});

test('a stalled preview does not stop another preview', () => {
  const stalled = fixture(), healthy = fixture();
  healthy.video.dispatchEvent(new Event('playing'));
  stalled.tick(60000);
  assert.equal(healthy.video.src, '/clip');
  assert.equal(healthy.video.pauses, 0);
  stalled.stop();
  healthy.stop();
});

test('concurrency is bounded, queued previews have no source or timeout, and leaving frees a slot', () => {
  const queue = createGalleryPlaybackQueue(2);
  const previews = Array.from({ length: 5 }, () => fixture(undefined, queue));
  assert.deepEqual(previews.map(f => f.video.plays), [1, 1, 0, 0, 0]);
  assert.equal(previews[2].video.src, '');
  assert.equal(previews[2].tasks.size, 0);
  previews[2].stop();
  previews[0].stop();
  assert.deepEqual(previews.map(f => f.video.plays), [1, 1, 0, 1, 0]);
  previews.forEach(f => f.stop());
});

test('a timed-out preview yields its slot and retries behind queued previews', () => {
  const queue = createGalleryPlaybackQueue(1);
  const slow = fixture(undefined, queue), next = fixture(undefined, queue);
  slow.tick(60000);
  assert.equal(next.video.plays, 1);
  slow.tick(500);
  assert.equal(slow.video.plays, 1);
  assert.equal(slow.tasks.size, 0);
  next.stop();
  assert.equal(slow.video.plays, 2);
  slow.stop();
});

test('background pause keeps the frame and source; foreground resumes without reloading', async () => {
  const page = Object.assign(new EventTarget(), { hidden: false });
  const rejections = [];
  const f = fixture(() => new Promise((_, reject) => rejections.push(reject)), undefined, page);
  f.video.dispatchEvent(new Event('playing'));
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.src, '/clip');
  assert.equal(f.video.loads, 0);
  assert.equal(f.tasks.size, 0);
  assert.deepEqual(f.ready, [true]);
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.plays, 2);
  assert.equal(f.video.loads, 0);
  rejections[0](new Error('background interruption'));
  await Promise.resolve();
  assert.equal(f.errors(), 0);
  assert.equal(f.video.src, '/clip');
  f.stop();
  assert.equal(f.video.src, '');
  assert.equal(f.video.loads, 1);
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.plays, 2);
});

test('previews created in the background wait for visibility before loading', () => {
  const page = Object.assign(new EventTarget(), { hidden: true });
  const f = fixture(undefined, undefined, page);
  assert.equal(f.video.src, '');
  assert.equal(f.tasks.size, 0);
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.plays, 1);
  f.stop();
});

test('briefly leaving retains source and position while releasing the playback slot', () => {
  const queue = createGalleryPlaybackQueue(1);
  const first = fixture(undefined, queue), second = fixture(undefined, queue);
  first.video.currentTime = 42;
  first.video.dispatchEvent(new Event('playing'));
  first.stop.setEnabled(false);
  assert.equal(first.video.src, '/clip');
  assert.equal(first.video.currentTime, 42);
  assert.equal(first.video.loads, 0);
  assert.deepEqual(first.ready, [true]);
  assert.equal(first.tasks.size, 0);
  assert.equal(second.video.plays, 1);
  first.stop.setEnabled(true);
  assert.equal(first.video.plays, 1, 'resumption still respects concurrency');
  second.stop();
  assert.equal(first.video.plays, 2);
  assert.equal(first.video.currentTime, 42);
  assert.equal(first.video.loads, 0);
  first.stop();
});

test('an offscreen cached preview stays paused when the app returns to foreground', () => {
  const page = Object.assign(new EventTarget(), { hidden: false });
  const f = fixture(undefined, undefined, page);
  f.stop.setEnabled(false);
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  page.hidden = false;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.plays, 1);
  assert.equal(f.video.src, '/clip');
  f.stop();
});

test('paused cache evicts oldest previews and forgets those resumed or unloaded', () => {
  const cache = createGalleryPreviewCache(2);
  const evicted = [];
  const retain = key => cache.retain(key, () => evicted.push(key));
  retain('a'); retain('b'); retain('a'); retain('c');
  assert.deepEqual(evicted, ['b']);
  cache.forget('a');
  retain('d');
  assert.deepEqual(evicted, ['b']);
  retain('e');
  assert.deepEqual(evicted, ['b', 'c']);
});

test('resolution budget accounts for portrait, intermediate, unknown and oversized videos', () => {
  for (const [width, height, expected] of [
    [1280, 720, 1], [720, 1280, 1], [1920, 1080, 2],
    [1080, 1920, 2], [2560, 1440, 4], [3840, 2160, 8],
    [2160, 3840, 8], [4096, 2160, 8], [7680, 4320, 16],
    [0, 1080, 4], [NaN, 720, 4],
  ]) assert.equal(galleryPlaybackWeight({ width, height }), expected);
  assert.equal(galleryPlaybackWeight(undefined), 4);
});

test('default budget admits eight full HD streams or two 4K streams', () => {
  for (const [weight, count] of [[2, 8], [8, 2]]) {
    const queue = createGalleryPlaybackQueue();
    let started = 0;
    const jobs = Array.from({ length: count + 1 }, () => queue.request(() => started++, weight));
    assert.equal(started, count);
    jobs[0]();
    assert.equal(started, count + 1);
    jobs.forEach(cancel => cancel());
  }
});

test('mixed weights share the budget and a large waiting stream does not block smaller streams', () => {
  const queue = createGalleryPlaybackQueue(8), started = [];
  const a = queue.request(() => started.push('a'), 4);
  const b = queue.request(() => started.push('b'), 8);
  const c = queue.request(() => started.push('c'), 2);
  const d = queue.request(() => started.push('d'), 2);
  assert.deepEqual(started, ['a', 'c', 'd']);
  a(); c();
  assert.deepEqual(started, ['a', 'c', 'd']);
  d();
  assert.deepEqual(started, ['a', 'c', 'd', 'b']);
  b(); b();
});

test('an oversized stream can run alone instead of waiting forever', () => {
  const queue = createGalleryPlaybackQueue(8);
  let started = 0;
  const huge = queue.request(() => started++, 16);
  const next = queue.request(() => started++, 1);
  assert.equal(started, 1);
  huge();
  assert.equal(started, 2);
  next();
});

test('actual metadata adjusts reservations without unloading the source or resetting position', () => {
  const queue = createGalleryPlaybackQueue(4);
  const first = fixture(undefined, queue, undefined, null);
  const next = fixture(undefined, queue);
  assert.equal(next.video.plays, 0);
  first.video.currentTime = 12;
  first.video.videoWidth = 1280;
  first.video.videoHeight = 720;
  first.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(next.video.plays, 1);
  assert.equal(first.video.plays, 2);
  assert.equal(first.video.loads, 0);
  assert.equal(first.video.currentTime, 12);
  first.stop(); next.stop();
});

test('higher resolution discovered during playback must wait for enough budget', () => {
  const queue = createGalleryPlaybackQueue(8);
  const first = fixture(undefined, queue);
  const next = fixture(undefined, queue);
  first.video.videoWidth = 3840;
  first.video.videoHeight = 2160;
  first.video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(first.video.plays, 1);
  assert.equal(first.video.loads, 0);
  next.stop();
  assert.equal(first.video.plays, 2);
  first.stop();
});

test('large queued videos get a turn even when smaller videos keep looping', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(8, clock);
  const small = Array.from({ length: 4 }, () => fixture(undefined, queue, undefined, { width: 1920, height: 1080 }));
  for (const f of small) f.video.dispatchEvent(new Event('playing'));
  const large = fixture(undefined, queue, undefined, { width: 3840, height: 2160 });
  assert.equal(large.video.plays, 0);
  clock.tick();
  assert.equal(large.video.plays, 1);
  for (const f of small) {
    assert.equal(f.video.pauses, 1);
    assert.equal(f.video.loads, 0);
    assert.deepEqual(f.ready, [true]);
  }
  large.video.dispatchEvent(new Event('playing'));
  clock.tick();
  assert.ok(small.some(f => f.video.plays === 2));
  for (const f of [...small, large]) f.stop();
  assert.equal(clock.tasks.size, 0);
});

test('ordinary rotation gives a slow starting video time to load', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(1, clock);
  const slow = fixture(undefined, queue), next = fixture(undefined, queue);
  clock.tick();
  assert.equal(slow.video.pauses, 0);
  assert.equal(next.video.plays, 0);
  slow.video.dispatchEvent(new Event('playing'));
  clock.tick();
  assert.equal(next.video.plays, 1);
  slow.stop(); next.stop();
  assert.equal(clock.tasks.size, 0);
});

test('hover borrows one slot without pausing automatic previews', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(8, clock);
  const small = Array.from({ length: 4 }, () => fixture(undefined, queue, undefined, { width: 1920, height: 1080 }));
  const large = fixture(undefined, queue, undefined, { width: 3840, height: 2160 });
  large.stop.setPriority(true);
  assert.equal(large.video.plays, 1);
  for (const f of small) {
    assert.equal(f.video.pauses, 0);
    assert.equal(f.video.loads, 0);
  }
  assert.equal(clock.tasks.size, 0, 'no rotation is needed when everyone can play');
  large.stop.setPriority(false);
  assert.equal(large.video.pauses, 1, 'hover exit returns to the automatic budget');
  assert.equal(large.video.loads, 0);
  for (const f of [...small, large]) f.stop();
});

test('the extra slot is bounded and released on cancellation', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(1, clock);
  const automatic = fixture(undefined, queue);
  const first = fixture(undefined, queue), second = fixture(undefined, queue);
  first.stop.setPriority(true);
  second.stop.setPriority(true);
  assert.equal(first.video.plays, 1);
  assert.equal(second.video.plays, 0);
  assert.equal(automatic.video.pauses, 0);
  first.stop();
  assert.equal(second.video.plays, 1);
  assert.equal(automatic.video.pauses, 0);
  automatic.stop(); second.stop();
  assert.equal(clock.tasks.size, 0);
});

test('a borrowed preview returns to available budget without pausing or reloading', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(1, clock);
  const automatic = fixture(undefined, queue), hovered = fixture(undefined, queue);
  hovered.stop.setPriority(true);
  automatic.stop();
  hovered.stop.setPriority(false);
  assert.equal(hovered.video.plays, 1);
  assert.equal(hovered.video.pauses, 0);
  assert.equal(hovered.video.loads, 0);
  const next = fixture(undefined, queue);
  assert.equal(next.video.plays, 0, 'the former extra slot now counts against the normal budget');
  hovered.stop();
  assert.equal(next.video.plays, 1);
  next.stop();
});

test('cancelled waiters never rotate back into playback', () => {
  const clock = schedulerClock(), queue = createGalleryPlaybackQueue(1, clock);
  const first = fixture(undefined, queue), next = fixture(undefined, queue);
  first.video.dispatchEvent(new Event('playing'));
  next.stop();
  assert.equal(clock.tasks.size, 0);
  assert.equal(first.video.pauses, 0);
  assert.equal(next.video.plays, 0);
  first.stop();
});

test('growing buffer extends the timeout, repeated progress without new data does not', () => {
  const f = fixture();
  let end = 1;
  f.video.buffered = { length: 1, end: () => end };
  const initial = [...f.tasks.keys()][0];
  f.video.dispatchEvent(new Event('progress'));
  const progressed = [...f.tasks.keys()][0];
  assert.notEqual(progressed, initial);
  f.video.dispatchEvent(new Event('progress'));
  assert.equal([...f.tasks.keys()][0], progressed);
  end = 3;
  f.video.dispatchEvent(new Event('progress'));
  assert.notEqual([...f.tasks.keys()][0], progressed);
  assert.equal(f.video.loads, 0);
  f.stop();
});

test('cache eviction unloads once and reuses the same controller on reentry', () => {
  const f = fixture();
  f.video.dispatchEvent(new Event('playing'));
  f.stop.unload();
  f.stop.unload();
  assert.equal(f.video.src, '');
  assert.equal(f.video.loads, 1);
  assert.equal(f.tasks.size, 0);
  f.stop.setEnabled(true);
  assert.equal(f.video.src, '/clip');
  assert.equal(f.video.plays, 2);
  f.stop();
  f.stop();
  assert.equal(f.video.loads, 2);
});

test('hover explicitly retries a failed preview without remounting it', () => {
  const page = Object.assign(new EventTarget(), { hidden: false });
  const f = fixture(undefined, undefined, page);
  f.tick(60000); f.tick(500); f.tick(60000);
  assert.equal(f.errors(), 1);
  assert.equal(f.video.plays, 2);
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.plays, 2, 'foreground updates do not restart failed requests indefinitely');
  f.stop.setPriority(true);
  assert.equal(f.video.plays, 3);
  f.video.dispatchEvent(new Event('playing'));
  assert.equal(f.ready.at(-1), true);
  f.stop();
});
