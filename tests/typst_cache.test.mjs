import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepTypstCache } from '../library/typst-cache.mjs';

test('active Typst files protect only their latest revision, with a transition grace period', () => {
  const item = (id, lastUsed, inUse = 0) => ({ id, file: 'note.typ', lastUsed, inUse, pages: new Map([[1, 'svg']]) });
  const cache = new Map(['old', 'busy', 'recent', 'latest'].map((id, index) =>
    [id, item(id, index === 2 ? 90000 : 0, index === 1 ? 1 : 0)]));
  const options = { now: 100000, isActive: () => true, fileKey: file => file };
  sweepTypstCache(cache, options);
  assert.deepEqual([...cache.keys()], ['busy', 'recent', 'latest']);
  cache.get('busy').inUse = 0;
  sweepTypstCache(cache, { ...options, now: 1000000 });
  assert.deepEqual([...cache.keys()], ['latest']);
  assert.equal(cache.get('latest').pages.size, 0, 'active artifacts survive, but idle rendered pages are released');
});

test('idle Typst pages and documents are released without evicting a protected response', () => {
  const cache = new Map(['idle', 'protected'].map(id => [id,
    { id, file: id, lastUsed: 0, inUse: 0, pages: new Map([[1, 'svg']]) }]));
  const options = { isActive: () => false, fileKey: file => file, protectedId: 'protected' };
  sweepTypstCache(cache, { ...options, now: 300000 });
  assert.equal(cache.get('idle').pages.size, 0);
  assert.equal(cache.get('protected').pages.size, 1);
  sweepTypstCache(cache, { ...options, now: 900000 });
  assert.deepEqual([...cache.keys()], ['protected']);
});
