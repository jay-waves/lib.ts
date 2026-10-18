import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryLayout } from '../web/gallery-layout.mjs';

test('column cards preserve aspect ratios and stay in their column when dimensions arrive', () => {
  const before = galleryLayout([1, 1, 1, 1], 452, 220, false);
  const after = galleryLayout([.5, 1, 1, 1], 452, 220, false);
  assert.equal(after.items[0].height, 438);
  assert.equal(after.items[2].top, 450);
  assert.deepEqual(before.items[1], after.items[1]);
  assert.deepEqual(before.items[3], after.items[3]);
  assert.equal(after.height, after.items[2].top + after.items[2].height);
});

test('rows keep fixed height, proportional widths and wrap in input order', () => {
  const { items, height } = galleryLayout([1, .5, 2], 500, 200, true);
  assert.deepEqual(items, [
    { left: 0, top: 0, width: 202, height: 202 },
    { left: 214, top: 0, width: 102, height: 202 },
    { left: 0, top: 214, width: 402, height: 202 },
  ]);
  assert.equal(height, 416);
});

test('both modes fit narrow containers, produce no overlaps and include all cards after resizing', () => {
  for (const rows of [false, true]) {
    for (const width of [100, 600, 1000]) {
      const { items, height } = galleryLayout([.5, 1, 2, 3, .8], width, 220, rows);
      assert.equal(items.length, 5);
      for (const [index, item] of items.entries()) {
        assert.ok(item.left >= 0 && item.left + item.width <= width + 1e-6);
        assert.ok(item.top + item.height <= height + 1e-6);
        for (const other of items.slice(index + 1)) {
          assert.ok(item.left + item.width <= other.left || other.left + other.width <= item.left
            || item.top + item.height <= other.top || other.top + other.height <= item.top);
        }
      }
    }
    assert.deepEqual(galleryLayout([], 600, 220, rows), { items: [], height: 0 });
  }
});
