import test from 'node:test';
import assert from 'node:assert/strict';
import { createSvgCache } from '../library/svg-cache.mjs';
import { readingKey, readPosition, savePosition, pagePosition, restorePagePosition } from '../library/reading-state.mjs';

test('SVG cache deduplicates concurrent loads, bounds retained pages and retries failures', async () => {
  const calls = [];
  const cache = createSvgCache(2, async url => {
    calls.push(url);
    return { ok: url !== 'expired', status: 410, text: async () => url };
  });
  assert.deepEqual(await Promise.all([cache('a'), cache('a')]), ['a', 'a']);
  assert.equal(calls.length, 1);
  await cache('b'); await cache('a'); await cache('c');
  await cache('b');
  assert.deepEqual(calls, ['a', 'b', 'c', 'b']);
  await assert.rejects(cache('expired'), error => error.status === 410);
  await assert.rejects(cache('expired'), error => error.status === 410);
  assert.equal(calls.filter(url => url === 'expired').length, 2);
});

test('reading positions preserve source line, view and fold anchors independently per repository', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const key = readingKey('notes', 'file.md');
  savePosition(key, { line: 20, view: 'raw' }, storage);
  savePosition(key, { collapsed: ['H1:heading:0'] }, storage);
  assert.deepEqual(readPosition(key, storage), { line: 20, view: 'raw', collapsed: ['H1:heading:0'] });
  assert.deepEqual(readPosition(readingKey('other', 'file.md'), storage), {});
});

test('zoom compensation keeps the same page coordinate under the mouse', () => {
  let rect = { left: 200, top: 100, bottom: 700, width: 400, height: 600 };
  let delta;
  const panel = { querySelectorAll: () => [{ getBoundingClientRect: () => rect }], scrollBy: value => { delta = { ...delta, ...value }; } };
  const saved = pagePosition(panel, 300, 400);
  rect = { left: 200, top: 100, bottom: 1300, width: 800, height: 1200 };
  restorePagePosition(panel, saved, 300, 400);
  assert.equal(delta.left, 100);
  assert.equal(delta.top, 300);
});

test('document viewport restores both axes in one scroll operation', () => {
  const movements = [];
  const page = { getBoundingClientRect: () => ({ left: 20, top: 50, width: 1200, height: 1800 }) };
  const panel = { querySelectorAll: () => [page], scrollBy: value => movements.push(value) };
  restorePagePosition(panel, { index: 0, x: .5, y: .25 }, 300, 350);
  assert.deepEqual(movements, [{ left: 320, top: 150, behavior: 'instant' }]);
});

test('page lookup matches a linear search across mixed page sizes, gaps and document edges', () => {
  let top = -300;
  const rects = Array.from({ length: 40 }, (_, index) => {
    const height = 100 + index % 5 * 70;
    const rect = { left: 20, top, bottom: top + height, width: 400 + index, height };
    top += height + 18;
    return rect;
  });
  const panel = { querySelectorAll: () => rects.map(rect => ({ getBoundingClientRect: () => rect })) };
  const ys = [-1000, top + 1000, ...rects.flatMap(rect => [rect.top, rect.bottom, rect.bottom + 8, rect.bottom + 9, rect.bottom + 10])];
  for (const y of ys) {
    const index = rects.reduce((best, rect, index) =>
      Math.max(rect.top - y, y - rect.bottom, 0) < Math.max(rects[best].top - y, y - rects[best].bottom, 0) ? index : best, 0);
    const rect = rects[index];
    assert.deepEqual(pagePosition(panel, 123, y), { index, x: (123 - rect.left) / rect.width, y: (y - rect.top) / rect.height });
  }
});

test('long documents need only logarithmically many geometry reads', () => {
  let reads = 0;
  const pages = Array.from({ length: 10000 }, (_, index) => ({ getBoundingClientRect() {
    reads++;
    return { left: 0, top: index * 120, bottom: index * 120 + 100, width: 90, height: 100 };
  } }));
  assert.equal(pagePosition({ querySelectorAll: () => pages }, 45, 8765 * 120 + 50).index, 8765);
  assert.ok(reads <= 16, `Expected at most 16 geometry reads, got ${reads}`);
});

test('empty and hidden pages do not produce invalid positions', () => {
  assert.equal(pagePosition({ querySelectorAll: () => [] }, 0, 0), undefined);
  const hidden = { getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0 }) };
  assert.equal(pagePosition({ querySelectorAll: () => [hidden, hidden] }, 0, 0), undefined);
  const visible = { getBoundingClientRect: () => ({ left: 0, top: 10, bottom: 110, width: 100, height: 100 }) };
  assert.deepEqual(pagePosition({ querySelectorAll: () => [visible, hidden, hidden] }, 50, 60), { index: 0, x: .5, y: .5 });
});


test('SVG cache decodes and caches image/link responses only once', async () => {
  let requests = 0, decodes = 0;
  const image = { svg: '<svg/>', links: [{ page: 2 }] };
  const cache = createSvgCache(2, async () => { requests++; return { ok: true, json: async () => image }; },
    response => { decodes++; return response.json(); });
  assert.deepEqual(await Promise.all([cache('page'), cache('page')]), [image, image]);
  assert.equal(await cache('page'), image);
  assert.equal(requests, 1);
  assert.equal(decodes, 1);
});

test('SVG cache limits retained bytes and aborts old document requests without refilling the cache', async () => {
  const calls = [];
  let complete, signal;
  const cache = createSvgCache(16, (url, options) => {
    calls.push(url);
    if (url === 'pending') {
      signal = options.signal;
      return new Promise(resolve => { complete = () => resolve({ ok: true, text: async () => 'late' }); });
    }
    return Promise.resolve({ ok: true, text: async () => url });
  }, response => response.text(), 8);
  await cache('aaaa'); await cache('bbbb'); await cache('aaaa');
  assert.deepEqual(calls, ['aaaa', 'bbbb', 'aaaa']);
  await cache('oversized'); await cache('oversized');
  assert.equal(calls.filter(url => url === 'oversized').length, 2);
  const pending = cache('pending');
  cache.clear();
  assert.equal(signal.aborted, true);
  complete();
  assert.equal(await pending, 'late');
  const again = cache('pending');
  assert.equal(calls.filter(url => url === 'pending').length, 2);
  complete();
  await again;
});
