import test from 'node:test';
import assert from 'node:assert/strict';
import { initialImageScale } from '../web/document-preview.mjs';
import { thumbnailUrl, imagePreviewUrls } from '../web/media-urls.mjs';

test('images start at native size with a maximum of 80% of viewport width', () => {
  assert.equal(initialImageScale(200, 1000), 1);
  assert.equal(initialImageScale(800, 1000), 1);
  assert.equal(initialImageScale(1600, 1000), .5);
  assert.equal(initialImageScale(10000, 500), .04);
  assert.equal(initialImageScale(0, 1000), 1);
});

const image = { path: '照片/a & b.jpg', name: 'a & b.jpg', modified: '2026-10-18T00:00:00Z',
  size: 1024, preview: 'original', url: '/repo/api/asset?path=photo', imageMetadata: { dimensions: { width: 800, height: 600 } } };

test('ordinary previews use a stable original URL independently of metadata and image size', () => {
  const { thumbnail, source } = imagePreviewUrls('/repo/api', image);
  assert.equal(thumbnail, thumbnailUrl('/repo/api', image));
  assert.notEqual(thumbnail, source);
  const url = new URL(source, 'http://localhost');
  assert.equal(url.pathname, '/repo/api/media');
  assert.equal(url.searchParams.get('path'), image.path);
  assert.equal(url.searchParams.has('conversion'), false);
  assert.deepEqual(url.searchParams.getAll('v'), [image.modified]);
  for (const document of [
    { ...image, imageMetadata: undefined },
    { ...image, size: 100_000_000, imageMetadata: { dimensions: { width: 10000, height: 8000 } } },
  ]) assert.equal(imagePreviewUrls('/repo/api', document).source, source);
  assert.notEqual(imagePreviewUrls('/repo/api', { ...image, modified: 'new-version' }).source, source);
});

test('HEIF uses the cached Gallery preview while fetching the full conversion', () => {
  const urls = imagePreviewUrls('/repo/api', { ...image, name: 'photo.HEIC', preview: 'converted' });
  assert.notEqual(urls.thumbnail, urls.source);
  const url = new URL(urls.source, 'http://localhost');
  assert.equal(url.pathname, '/repo/api/media/preview');
  assert.deepEqual(url.searchParams.getAll('v'), [image.modified]);
  for (const resource of [urls.thumbnail, urls.source]) {
    assert.equal(new URL(resource, 'http://localhost').searchParams.get('conversion'), 'heif-grid-v1');
  }
  // Gallery callers can identify HEIF from its path before metadata arrives.
  const gallery = new URL(thumbnailUrl('/repo/api', { path: 'photo.HEIF', modified: image.modified }), 'http://localhost');
  assert.equal(gallery.searchParams.get('conversion'), 'heif-grid-v1');
});
