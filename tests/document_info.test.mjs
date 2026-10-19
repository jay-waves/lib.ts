import test from 'node:test';
import assert from 'node:assert/strict';
import { readDocumentInfo, storeDocumentInfo, storeDocumentInfos } from '../web/document-info.ts';

globalThis.localStorage = undefined;

const info = { path: 'source.ts', name: 'source.ts', absolutePath: '/notes/source.ts', size: 12,
  modified: '2026-10-19T00:00:00Z', type: 'text', mime: 'text/plain', format: 'ts', media: null, playable: false };

function storage(t) {
  const entries = new Map();
  t.mock.property(globalThis, 'localStorage', {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  });
  return entries;
}

test('only server descriptions determine format, and repositories have separate entries', t => {
  storage(t);
  assert.equal(readDocumentInfo('/a/api', info.path), null);
  storeDocumentInfo('/a/api', info.path, info);
  const video = { ...info, type: 'binary', mime: 'video/mp2t', media: 'video' };
  storeDocumentInfo('/b/api', info.path, video);
  assert.deepEqual(readDocumentInfo('/a/api', info.path), info);
  assert.deepEqual(readDocumentInfo('/b/api', info.path), video);
  storeDocumentInfo('/a/api', info.path, video);
  assert.deepEqual(readDocumentInfo('/a/api', info.path), video);
  storeDocumentInfo('/a/api', info.path, null);
  assert.equal(readDocumentInfo('/a/api', info.path), null);
  assert.deepEqual(readDocumentInfo('/b/api', info.path), video);
});

test('cache is bounded and refreshing an entry keeps it among recent files', t => {
  storage(t);
  for (let index = 0; index < 100; index++) storeDocumentInfo('/a/api', String(index), { ...info, path: String(index) });
  storeDocumentInfo('/a/api', '0', { ...info, path: '0' });
  storeDocumentInfo('/a/api', '100', { ...info, path: '100' });
  assert.ok(readDocumentInfo('/a/api', '0'));
  assert.equal(readDocumentInfo('/a/api', '1'), null);
  assert.ok(readDocumentInfo('/a/api', '100'));
});

test('invalid storage and older response shapes are treated as cache misses', t => {
  const entries = storage(t);
  for (const value of ['{', 'null', '{}', '[null]', JSON.stringify([{ repository: '/a/api', info: { path: info.path } }])]) {
    entries.set('lib-ts:file-descriptors:v1', value);
    assert.equal(readDocumentInfo('/a/api', info.path), null);
  }
});

test('blocked storage does not prevent loading server descriptions', t => {
  t.mock.property(globalThis, 'localStorage', {
    getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
  });
  assert.equal(readDocumentInfo('/a/api', info.path), null);
  assert.doesNotThrow(() => storeDocumentInfo('/a/api', info.path, info));
});


test('gallery descriptions and dimensions survive validation but expire when the file changes', t => {
  storage(t);
  const descriptor = { ...info, type: 'image', mime: 'image/png', media: 'image', format: 'png', preview: 'original' };
  const gallery = { ...descriptor, dimensions: { width: 1200, height: 800 }, capturedAt: 123 };
  storeDocumentInfos('/a/api', [gallery]);
  assert.deepEqual(readDocumentInfo('/a/api', info.path), gallery);
  assert.deepEqual(storeDocumentInfo('/a/api', info.path, descriptor), gallery);
  const changed = { ...descriptor, modified: '2026-10-19T00:01:00Z' };
  assert.deepEqual(storeDocumentInfo('/a/api', info.path, changed), changed);
  assert.equal(readDocumentInfo('/a/api', info.path).dimensions, undefined);
  storeDocumentInfo('/a/api', info.path, gallery);
  assert.deepEqual(storeDocumentInfo('/a/api', info.path, info), info, 'a type correction discards media-only fields');
});
