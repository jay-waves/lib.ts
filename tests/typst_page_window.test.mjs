import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTypstWindow } from '../library/typst-page-window.mjs';
import { observePageWindow } from '../library/page-window.mjs';

test('page boundary reversals keep mounted SVG until the buffer needs replenishing', () => {
  const initial = { first: 1, last: 3 };
  assert.equal(nextTypstWindow(initial, 1, 1, 100), initial);
  assert.equal(nextTypstWindow(initial, 1, 2, 100), initial);
  const moved = nextTypstWindow(initial, 2, 3, 100);
  assert.deepEqual(moved, { first: 1, last: 5 });
  for (const [first, last] of [[2, 2], [2, 3], [3, 3], [3, 4], [2, 3]]) {
    assert.equal(nextTypstWindow(moved, first, last, 100), moved);
  }
  assert.deepEqual(nextTypstWindow(moved, 4, 5, 100), { first: 2, last: 7 });
});

test('a textbook traversal keeps a small image window and zooming back in releases the wider window', () => {
  let window = { first: 1, last: 3 };
  for (let page = 1; page <= 800; page++) {
    window = nextTypstWindow(window, page, Math.min(800, page + 1), 800);
    assert.ok(window.first <= page && window.last >= Math.min(800, page + 1));
    assert.ok(window.last - window.first + 1 <= 6);
  }
  const wide = nextTypstWindow(window, 400, 420, 800);
  const narrow = nextTypstWindow(wide, 410, 410, 800);
  assert.deepEqual(narrow, { first: 408, last: 412 });
});

test('one observer tracks placeholder pages, handles direct jumps, and disconnects on unmount', () => {
  const pages = Array.from({ length: 400 }, (_, index) => ({ dataset: { page: String(index + 1) } }));
  const viewport = {};
  let callback, disconnected = false;
  const observed = [], windows = [];
  class Observer {
    constructor(notify, options) { callback = notify; assert.equal(options.root, viewport); }
    observe(page) { observed.push(page); }
    disconnect() { disconnected = true; }
  }
  const stop = observePageWindow({ closest: () => viewport, querySelectorAll: () => pages }, 400, value => windows.push(value), Observer);
  assert.equal(observed.length, 400);
  callback([{ target: pages[0], isIntersecting: true }]);
  callback([{ target: pages[0], isIntersecting: false }, { target: pages[299], isIntersecting: true }]);
  assert.deepEqual(windows.at(-1), { first: 298, last: 302 });
  stop();
  assert.equal(disconnected, true);
});

test('direct jumps, zoom showing multiple pages, and document edges remain covered', () => {
  const jumped = nextTypstWindow({ first: 1, last: 3 }, 50, 51, 100);
  assert.deepEqual(jumped, { first: 48, last: 53 });
  assert.deepEqual(nextTypstWindow(jumped, 45, 55, 100), { first: 43, last: 57 });
  assert.deepEqual(nextTypstWindow(jumped, 99, 100, 100), { first: 97, last: 100 });
  assert.deepEqual(nextTypstWindow(jumped, 1, 1, 2), { first: 1, last: 2 });
});
