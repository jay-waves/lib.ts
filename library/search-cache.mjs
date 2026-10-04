import { LRUCache } from 'lru-cache';

// Shared across repositories so opening more repositories cannot multiply the budget.
export function createSearchCachePool(maxBytes = 8 * 1024 * 1024) {
  const entries = new LRUCache({ maxSize: maxBytes,
    sizeCalculation: entry => Math.max(1, Math.ceil(entry.bytes)),
    ttlAutopurge: true, ttlResolution: 0, perf: { now: () => Date.now() },
    dispose: entry => entry.cache.delete(entry.id) });
  let nextScope = 0;
  return function createCache({ limit = 4, ttl = 300000 } = {}) {
    const scope = ++nextScope;
    const cache = new Map();
    const key = id => `${scope}:${id}`;
    const remove = id => entries.delete(key(id));
    return {
      get: id => cache.get(id),
      has: id => cache.has(id),
      values: () => cache.values(),
      [Symbol.iterator]: () => cache[Symbol.iterator](),
      delete: remove,
      set(id, value) {
        if (cache.has(id)) return;
        const weight = value.resultBytes;
        if (!Number.isFinite(weight) || weight < 0 || weight > maxBytes) throw new Error('Search result exceeds cache budget.');
        while (cache.size >= limit) remove(cache.keys().next().value);
        cache.set(id, value);
        entries.set(key(id), { id, cache, bytes: weight }, { ttl });
      },
    };
  };
}

export const createSearchCache = createSearchCachePool();
