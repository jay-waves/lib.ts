// Document identities/source snapshots. Artifact residency is owned by the worker.
export function sweepTypstCache(cache, { now = Date.now(), protectedId = null, isActive, fileKey,
  versionKey = item => fileKey(item.file), documentIdleMs = 900000, limit = 64,
  maxBytes = 16 * 1024 * 1024, maxVersions = 2, versionGraceMs = 15000 }) {
  const latest = new Map();
  const versions = new Map();
  for (const item of cache.values()) {
    const key = versionKey(item);
    latest.set(key, item.id);
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push(item);
  }
  const active = item => isActive(item.file) && latest.get(versionKey(item)) === item.id;
  const protectedItem = item => item.id === protectedId || item.inUse;
  // Bound history even during the transition grace period. In-use versions
  // are released on the sweep after their last page request completes.
  for (const items of versions.values()) {
    for (const item of items.slice(0, Math.max(0, items.length - maxVersions))) {
      if (!protectedItem(item)) cache.delete(item.id);
    }
  }
  for (const item of cache.values()) {
    const superseded = latest.get(versionKey(item)) !== item.id;
    if (superseded) item.supersededAt ??= now;
    if (protectedItem(item)) continue;
    const idle = now - item.lastUsed;
    if (active(item)) continue;
    // Reading an old page must not extend the lifetime of its revision.
    if (superseded && now - item.supersededAt >= versionGraceMs) {
      cache.delete(item.id);
      continue;
    }
    if (idle >= documentIdleMs) cache.delete(item.id);
  }
  const evictable = [...cache.values()]
    .filter(item => !protectedItem(item))
    .sort((a, b) => Number(active(a)) - Number(active(b)) || a.lastUsed - b.lastUsed);
  const sourceBytes = item => (item.request?.source.length || 0) * 2;
  let bytes = [...cache.values()].reduce((sum, item) => sum + sourceBytes(item), 0);
  for (const item of evictable) {
    if (cache.size <= limit && bytes <= maxBytes) break;
    if (cache.size === 1 && bytes > maxBytes) break;
    cache.delete(item.id);
    bytes -= sourceBytes(item);
  }
  // Pins and one oversized source snapshot are allowed above this cache budget.
}
