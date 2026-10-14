import { LRUCache } from 'lru-cache';

// Keep only application sizing policy here; eviction and expiry belong to lru-cache.
export function createByteCache({ maxEntries, maxBytes, sizeOf, ttl = 0, now }) {
  return new LRUCache({ max: maxEntries, maxSize: maxBytes,
    sizeCalculation: value => Math.max(1, Math.ceil(sizeOf(value))),
    ttl: Number.isFinite(ttl) ? ttl : 0, ttlAutopurge: true, ttlResolution: 0,
    updateAgeOnGet: true, ...(now ? { perf: { now } } : {}) });
}

export function svgImageBytes(value) {
  if (typeof value === 'string') return value.length * 2;
  return value.svg.length * 2 + (value.links || []).reduce((bytes, link) => bytes + 192 + (link.href?.length || 0) * 2, 0);
}
