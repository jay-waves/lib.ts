import test from 'node:test';
import assert from 'node:assert/strict';
import { getMediaMetadata, getMediaDimensions, openMedia, mediaMetadataSchema } from '../web/api/media.ts';
import { documentSchema } from '../web/api/documents.ts';

test('media API encodes paths, supports cancellation and shares the video contract', async t => {
  const controller = new AbortController();
  const path = '视频/a & b.MOV';
  const value = { path, modified: 'v1', media: { kind: 'video', details: { dimensions: { width: 1920, height: 1080 }, durationSeconds: 20, codec: 'h264' } } };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, 'http://localhost');
    assert.equal(target.pathname, '/repo/api/media/metadata');
    assert.equal(target.searchParams.get('path'), path);
    assert.equal(options.signal, controller.signal);
    return Response.json(value);
  });
  assert.deepEqual(await getMediaMetadata('/repo/api', path, controller.signal), mediaMetadataSchema.parse(value));
  fetch.mock.mockImplementation(async (_url, options) => { options.signal.throwIfAborted(); });
  controller.abort();
  await assert.rejects(getMediaMetadata('/repo/api', path, controller.signal), { name: 'AbortError' });
});

test('gallery batches return reusable descriptors without inventing missing dimensions', async t => {
  const result = { files: [{ path: 'a.jpg', absolutePath: '/photos/a.jpg', name: 'a.jpg', size: 12, modified: 'v1',
    type: 'image', mime: 'image/jpeg', format: 'jpg', media: 'image', playable: false, preview: 'original' }] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/repo/api/media/dimensions');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { paths: ['a.jpg'], includeCaptureTime: true });
    return Response.json(result);
  });
  assert.deepEqual(await getMediaDimensions('/repo/api', ['a.jpg'], undefined, true), result);
});

test('image metadata loads independently and validates optional dimensions, EXIF and cancellation', async t => {
  const controller = new AbortController(), path = 'photos/a & b.heic';
  const value = { path, modified: 'v1', media: { kind: 'image', details: { dimensions: { width: 4000, height: 3000 }, exif: ['Camera'], capturedAt: 123 } } };
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url, 'http://localhost');
    assert.equal(target.pathname, '/repo/api/media/metadata');
    assert.equal(target.searchParams.get('path'), path);
    assert.equal(options.signal, controller.signal);
    return Response.json(value);
  });
  assert.deepEqual(await getMediaMetadata('/repo/api', path, controller.signal), value);
  fetch.mock.mockImplementation(async () => Response.json({ ...value, media: { kind: 'image', details: { exif: [] } } }));
  assert.deepEqual((await getMediaMetadata('/repo/api', path)).media, { kind: 'image', details: { exif: [] } });
  fetch.mock.mockImplementation(async () => Response.json({ exif: 'invalid' }));
  await assert.rejects(getMediaMetadata('/repo/api', path), /Invalid API response/);
  fetch.mock.mockImplementation(async (_url, options) => options.signal.throwIfAborted());
  controller.abort();
  await assert.rejects(getMediaMetadata('/repo/api', path, controller.signal), { name: 'AbortError' });
});

test('image documents validate the backend preview policy', () => {
  const image = { type: 'image', path: 'a.jpg', absolutePath: '/a.jpg', name: 'a.jpg', size: 12,
    modified: 'now', mime: 'image/jpeg', format: 'jpg', url: '/asset?path=a.jpg' };
  for (const preview of ['original', 'converted']) {
    assert.equal(documentSchema.parse({ ...image, preview }).preview, preview);
  }
  assert.equal(documentSchema.safeParse({ ...image, preview: 'invalid' }).success, false);
});

test('system opening sends a repository path and reports backend launch errors', async t => {
  const path = '视频/a & b.ts';
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/repo/api/media/open');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), { path });
    return Response.json({ ok: true, target: 'server' });
  });
  assert.deepEqual(await openMedia('/repo/api', path), { ok: true, target: 'server' });
  fetch.mock.mockImplementation(async () => Response.json({ error: 'Not an image or video file' }, { status: 400 }));
  await assert.rejects(openMedia('/repo/api', path), /Not an image or video file/);
});
