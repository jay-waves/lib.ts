import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryLayout, galleryRows, galleryRowLayout } from '../web/gallery-layout.mjs';

test('column cards preserve aspect ratios and stay in their column when dimensions arrive', () => {
  const before = galleryLayout([1, 1, 1, 1], 452, 220);
  const after = galleryLayout([.5, 1, 1, 1], 452, 220);
  assert.equal(after.items[0].height, 438);
  assert.equal(after.items[2].top, 450);
  assert.deepEqual(before.items[1], after.items[1]);
  assert.deepEqual(before.items[3], after.items[3]);
  assert.equal(after.height, after.items[2].top + after.items[2].height);
});

test('appending prepared batches leaves existing column cards and complete row batches in place', () => {
  const ratios = Array.from({ length: 150 }, (_, index) => [.5, 1, 2, 3, .8][index % 5]);
  for (const layout of [galleryLayout, galleryRowLayout]) {
    for (const width of [100, 600, 1400]) {
      const first = layout(ratios.slice(0, 64), width, 220);
      const second = layout(ratios.slice(0, 128), width, 220);
      const final = layout(ratios, width, 220);
      assert.deepEqual(second.items.slice(0, 64), first.items);
      assert.deepEqual(final.items.slice(0, 128), second.items);
      assert.ok(final.height >= second.height && second.height >= first.height);
      assert.equal(final.items.length, ratios.length);
    }
    assert.deepEqual(layout([], 600, 220), { items: [], height: 0 });
  }
});

test('adjusted rows fill their width and preserve photo proportions and order', () => {
  const photos = [1, .5, 2, 3, .8].map(width => ({ src: '', width, height: 1 }));
  for (const width of [100, 600, 1000]) {
    const { tracks } = galleryRows(photos, width, 220);
    assert.deepEqual(tracks.flatMap(track => track.photos.map(item => item.photo)), photos);
    for (const track of tracks) {
      assert.ok(Math.abs(track.photos.reduce((sum, item) => sum + item.width, 0) + 12 * (track.photos.length - 1) - width) < 1e-6);
      for (const item of track.photos) {
        assert.equal(item.height, track.photos[0].height);
        assert.ok(Math.abs(item.width / item.height - item.photo.width / item.photo.height) < 1e-6);
      }
    }
  }
});

test('columns fit narrow containers, produce no overlaps and include all cards after resizing', () => {
    for (const width of [100, 600, 1000]) {
      const { items, height } = galleryLayout([.5, 1, 2, 3, .8], width, 220);
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
    assert.deepEqual(galleryLayout([], 600, 220), { items: [], height: 0 });
});
