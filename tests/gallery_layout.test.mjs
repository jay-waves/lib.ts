import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryLayout, galleryRows, galleryRowLayout, galleryLoadMoreTop, galleryNeedsMore } from '../web/gallery/gallery-layout.mjs';

test('cards preserve aspect ratios and each new card fills the shortest column', () => {
  const { items, height } = galleryLayout([.5, 1, 1, 1], 452, 220);
  assert.equal(items[0].height, 438);
  assert.equal(items[2].left, items[1].left);
  assert.equal(items[2].top, items[1].height + 12);
  assert.equal(items[3].left, items[0].left);
  assert.equal(items[3].top, items[0].height + 12);
  assert.equal(height, items[3].top + items[3].height);
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

test('shortest-column placement bounds imbalance even with alternating portrait and landscape cards', () => {
  const layout = galleryLayout(Array.from({ length: 64 }, (_, i) => i % 2 ? 3 : .5), 452, 220);
  const bottoms = [0, layout.items[1].left].map(column => Math.max(...layout.items
    .filter(item => item.left === column).map(item => item.top + item.height)));
  assert.equal(galleryLoadMoreTop(layout), Math.min(...bottoms));
  assert.ok(layout.height - galleryLoadMoreTop(layout) <= Math.max(...layout.items.map(item => item.height)) + 12);
  assert.equal(galleryLoadMoreTop(galleryLayout([1], 600, 220), 2), 0, 'empty columns need more cards');
  assert.equal(galleryLoadMoreTop(galleryLayout([], 600, 220)), 0);
});

test('viewport coverage keeps requesting batches until every column extends one viewport ahead', () => {
  const ratios = Array(256).fill(3);
  let count = 64;
  const viewportBottom = 1600, viewportHeight = 800;
  while (galleryNeedsMore(galleryLoadMoreTop(galleryLayout(ratios.slice(0, count), 1400, 220)), viewportBottom, viewportHeight)) {
    count += 64;
    assert.ok(count <= ratios.length);
  }
  assert.ok(count > 64, 'one batch is insufficient even without another scroll event');
  assert.equal(galleryNeedsMore(2400, viewportBottom, viewportHeight), true);
  assert.equal(galleryNeedsMore(2401, viewportBottom, viewportHeight), false);
  assert.equal(galleryNeedsMore(2401, 10000, viewportHeight), true, 'a fast scroll past the previous edge still loads');
});
