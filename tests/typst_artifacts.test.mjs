import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactStore } from '../server/typst/artifacts.mjs';

test('worker artifact residency uses LRU and accounts for replacement bytes', () => {
  const store = createArtifactStore({ maxBytes: 100, maxEntries: 3 });
  for (const id of ['a', 'b', 'c']) store.set(id, { artifactBytes: 30 });
  store.get('a');
  store.set('d', { artifactBytes: 30 });
  assert.deepEqual([...store.keys()], ['c', 'a', 'd']);
  store.set('a', { artifactBytes: 80 });
  assert.deepEqual([...store.keys()], ['a']);
  assert.equal(store.bytes, 80);
  store.set('large', { artifactBytes: 200 });
  assert.deepEqual([...store.keys()], ['large']);
  store.set('small', { artifactBytes: 10 });
  assert.deepEqual([...store.keys()], ['small']);
  store.retain([]);
  assert.equal(store.bytes, 0);
});
