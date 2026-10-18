import test from 'node:test';
import assert from 'node:assert/strict';
import { getVideoMetadata, getMediaDimensions, videoMetadataSchema } from '../web/api/media.ts';
import { documentSchema } from '../web/api/documents.ts';

test('media API encodes paths, supports cancellation and shares the video contract', async t => {
  const controller = new AbortController();
  const path = '视频/a & b.MOV';
  const value = { dimensions: { width: 1920, height: 1080 }, durationSeconds: 20, codec: 'h264' };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, 'http://localhost');
    assert.equal(target.pathname, '/repo/api/media/metadata');
    assert.equal(target.searchParams.get('path'), path);
    assert.equal(options.signal, controller.signal);
    return Response.json(value);
  });
  assert.deepEqual(await getVideoMetadata('/repo/api', path, controller.signal), videoMetadataSchema.parse(value));
  fetch.mock.mockImplementation(async (_url, options) => { options.signal.throwIfAborted(); });
  controller.abort();
  await assert.rejects(getVideoMetadata('/repo/api', path, controller.signal), { name: 'AbortError' });
});

test('batch metadata preserves null dimensions and optional capture dates', async t => {
  const result = { dimensions: { 'a.jpg': null }, capturedAt: { 'a.jpg': null } };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/repo/api/media/dimensions');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { paths: ['a.jpg'], includeCaptureTime: true });
    return Response.json(result);
  });
  assert.deepEqual(await getMediaDimensions('/repo/api', ['a.jpg'], undefined, true), result);
});

test('image documents validate the backend preview policy', () => {
  const image = { type: 'image', path: 'a.jpg', absolutePath: '/a.jpg', name: 'a.jpg', size: 12,
    modified: 'now', mime: 'image/jpeg', format: 'jpg', url: '/asset?path=a.jpg' };
  for (const preview of ['original', 'thumbnail', 'converted']) {
    assert.equal(documentSchema.parse({ ...image, preview }).preview, preview);
  }
  assert.equal(documentSchema.safeParse({ ...image, preview: 'invalid' }).success, false);
});
