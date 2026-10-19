import test from 'node:test';
import assert from 'node:assert/strict';
import { createGalleryLoader } from '../web/gallery-media.ts';
import { thumbnailUrl } from '../web/media-urls.mjs';
import { sortDirectoryNodes } from '../web/gallery-images.ts';

const files = count => Array.from({ length: count }, (_, index) => ({
  type: 'file', name: `photo${index}.jpg`, path: `photo${index}.jpg`, modified: '2026-10-18T00:00:00Z',
}));
const metadata = paths => ({ files: paths.map(path => ({ path, name: path, modified: '2026-10-18T00:00:00Z',
  type: 'image', mime: 'image/jpeg', media: 'image', playable: false, dimensions: { width: 100, height: 200 } })) });

test('first 64 dimensions follow display order, and later batches wait for demand', async () => {
  const candidates = files(150).reverse();
  const calls = [], updates = [];
  const loader = createGalleryLoader(candidates, 'name-asc', async paths => {
    calls.push(paths);
    return metadata(paths);
  }, update => updates.push(update), new AbortController().signal);
  await loader.start();
  const ordered = sortDirectoryNodes(candidates, 'name-asc');
  assert.deepEqual(calls[0], ordered.slice(0, 64).map(node => node.path));
  assert.equal(calls.length, 1);
  assert.equal(updates[0].items.length, 64);
  assert.ok(updates[0].items.every(item => item.ratio === .5));
  await Promise.all([loader.loadMore(), loader.loadMore()]);
  assert.equal(calls.length, 2);
  assert.equal(updates[1].items.length, 128);
  assert.deepEqual(updates[1].items.slice(0, 64), updates[0].items);
  await loader.loadMore();
  await loader.loadMore();
  assert.equal(calls.length, 3);
  assert.deepEqual(updates[2].items.map(item => item.node.path), ordered.map(node => node.path));
});

test('capture dates establish global order before publishing the first batch', async () => {
  const candidates = files(80), calls = [], updates = [];
  const loader = createGalleryLoader(candidates, 'taken-desc', async (paths, _signal, capture) => {
    assert.equal(capture, true);
    calls.push(paths);
    return { files: metadata(paths).files.map(file => ({ ...file, capturedAt: Number(file.path.match(/\d+/)[0]) })) };
  }, update => updates.push(update), new AbortController().signal);
  await loader.start();
  assert.equal(calls.length, 2);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].items.length, 64);
  assert.equal(updates[0].items[0].node.path, 'photo79.jpg');
  assert.deepEqual(updates[0].files.map(file => file.path), updates[0].items.map(item => item.node.path),
    'the displayed batch supplies descriptors for the standalone-preview cache');
  await loader.loadMore();
  assert.equal(calls.length, 2, 'sizes obtained with capture dates are reused');
  assert.equal(updates[1].items.length, 80);
});

test('cancellation discards late responses from a previous gallery', async () => {
  for (const sort of ['name-asc', 'taken-desc']) {
    const controller = new AbortController(), updates = [];
    let resolve, calls = 0;
    const loader = createGalleryLoader(files(100), sort, paths => new Promise(done => {
      calls++;
      resolve = () => done(metadata(paths));
    }), update => updates.push(update), controller.signal);
    const pending = loader.start();
    controller.abort();
    resolve();
    await pending;
    await loader.loadMore();
    assert.deepEqual(updates, []);
    assert.equal(calls, 1);
  }
});

test('a failed batch keeps fixed proportions and never reveals the entire directory', async t => {
  t.mock.method(console, 'warn', () => {});
  const updates = [];
  let count = 0;
  const loader = createGalleryLoader(files(150), 'name-asc', async paths => {
    if (++count === 1) throw new Error('Unavailable');
    return metadata(paths);
  }, update => updates.push(update), new AbortController().signal);
  await loader.start();
  assert.equal(updates[0].items.length, 64);
  assert.ok(updates[0].items.every(item => item.ratio === 4 / 3));
  await loader.loadMore();
  assert.deepEqual(updates[1].items.slice(0, 64), updates[0].items);
  assert.equal(updates[1].items.length, 128);
});


test('gallery thumbnails and standalone previews share the descriptor version even when the tree is stale', async () => {
  const info = { ...metadata(['photo0.jpg']).files[0], modified: '2026-10-19T00:00:00Z' };
  let update;
  const loader = createGalleryLoader(files(1), 'name-asc', async () => ({ files: [info] }),
    value => { update = value; }, new AbortController().signal);
  await loader.start();
  assert.equal(update.items[0].ratio, .5);
  assert.equal(thumbnailUrl('/api', update.items[0].node), thumbnailUrl('/api', info));
  assert.equal(update.items[0].node.media, 'image');
});
