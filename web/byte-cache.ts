import { LRUCache } from 'lru-cache';

interface ByteCacheOptions<V> {
  maxEntries: number;
  maxBytes: number;
  sizeOf(value: V): number;
  ttl?: number;
  now?: () => number;
}

// Keep only application sizing policy here; eviction and expiry belong to lru-cache.
export function createByteCache<V extends {}>({ maxEntries, maxBytes, sizeOf, ttl = 0, now }: ByteCacheOptions<V>) {
  return new LRUCache<string, V>({ max: maxEntries, maxSize: maxBytes,
    sizeCalculation: value => Math.max(1, Math.ceil(sizeOf(value))),
    ttl: Number.isFinite(ttl) ? ttl : 0, ttlAutopurge: true, ttlResolution: 0,
    updateAgeOnGet: true, ...(now ? { perf: { now } } : {}) });
}

export function svgImageBytes(value: string | { svg: string; links?: { href?: string }[] }) {
  if (typeof value === 'string') return value.length * 2;
  return value.svg.length * 2 + (value.links || []).reduce((bytes, link) => bytes + 192 + (link.href?.length || 0) * 2, 0);
}
