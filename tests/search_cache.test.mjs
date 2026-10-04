import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchCachePool } from '../library/search-cache.mjs';

test('identical snapshot IDs in different repositories remain independent', () => {
  const createCache = createSearchCachePool(100);
  const first = createCache(), second = createCache();
  first.set('same', { resultBytes: 40 });
  second.set('same', { resultBytes: 40 });
  first.delete('same');
  assert.equal(second.has('same'), true);
  second.delete('same');
});

test('search cache budget spans repositories and expiration releases capacity', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const createCache = createSearchCachePool(100);
  const first = createCache({ ttl: 1000 }), second = createCache({ ttl: 2000 });
  first.set('a', { resultBytes: 60 });
  second.set('b', { resultBytes: 60 });
  assert.equal(first.has('a'), false);
  assert.equal(second.has('b'), true);
  first.set('c', { resultBytes: 40 });
  t.mock.timers.tick(1001);
  assert.equal(first.has('c'), false);
  first.set('d', { resultBytes: 40 });
  assert.equal(second.has('b'), true);
  assert.throws(() => first.set('oversized', { resultBytes: 101 }), /budget/);
  t.mock.timers.tick(1001);
  assert.equal(second.has('b'), false);
  assert.equal(first.has('d'), false);
});

test('per-search cache count evicts old snapshots and duplicate insertion does not reset expiry', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const cache = createSearchCachePool(1000)({ limit: 2, ttl: 100 });
  for (const id of ['a', 'b', 'c']) cache.set(id, { resultBytes: 10 });
  assert.deepEqual([...cache].map(([id]) => id), ['b', 'c']);
  t.mock.timers.tick(50);
  cache.set('c', { resultBytes: 10 });
  t.mock.timers.tick(51);
  assert.equal(cache.has('c'), false);
  cache.set('d', { resultBytes: 1000 });
  assert.equal(cache.has('d'), true);
  cache.delete('d');
});
