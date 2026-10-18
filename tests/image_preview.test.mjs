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
  size: 1024, preview: 'thumbnail', url: '/repo/api/asset?path=photo', imageMetadata: { dimensions: { width: 800, height: 600 } } };

test('small images reuse precisely the Gallery URL, including encoded paths and version', () => {
  const { thumbnail, source } = imagePreviewUrls('/repo/api', image);
  assert.equal(source, thumbnailUrl('/repo/api', image));
  assert.equal(thumbnail, source);
  const url = new URL(source, 'http://localhost');
  assert.equal(url.searchParams.get('path'), image.path);
  assert.deepEqual(url.searchParams.getAll('v'), [image.modified]);
  assert.notEqual(source, thumbnailUrl('/repo/api', { ...image, modified: 'new-version' }));
});

test('the API chooses original versus thumbnail; the frontend does not repeat size thresholds', () => {
  for (const document of [
    { ...image, preview: 'original' },
    { ...image, preview: undefined, imageMetadata: undefined },
  ]) {
    const urls = imagePreviewUrls('/repo/api', document);
    assert.notEqual(urls.thumbnail, urls.source);
    assert.equal(new URL(urls.source, 'http://localhost').pathname, '/repo/api/media');
  }
  const urls = imagePreviewUrls('/repo/api', { ...image, size: 100_000_000 });
  assert.equal(urls.thumbnail, urls.source);
});

test('HEIF uses the cached Gallery preview while fetching the full conversion', () => {
  const urls = imagePreviewUrls('/repo/api', { ...image, name: 'photo.HEIC', preview: 'converted' });
  assert.notEqual(urls.thumbnail, urls.source);
  const url = new URL(urls.source, 'http://localhost');
  assert.equal(url.pathname, '/repo/api/media/preview');
  assert.deepEqual(url.searchParams.getAll('v'), [image.modified]);
});
