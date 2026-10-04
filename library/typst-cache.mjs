export function sweepTypstCache(cache, { now = Date.now(), protectedId = null, isActive, fileKey,
  pageIdleMs = 300000, documentIdleMs = 900000, limit = 3 }) {
  const latest = new Map();
  for (const item of cache.values()) latest.set(fileKey(item.file), item.id);
  const active = item => isActive(item.file) && latest.get(fileKey(item.file)) === item.id;
  for (const item of cache.values()) {
    if (item.id === protectedId || item.inUse) continue;
    const idle = now - item.lastUsed;
    // A mounted page owns its image; idle server SVGs can be regenerated even
    // while the document is open. Keep its vector artifact for later pages.
    if (idle >= pageIdleMs) item.pages.clear();
    if (active(item)) continue;
    // Allow clients one minute to switch to the new metadata/page URLs.
    if (latest.get(fileKey(item.file)) !== item.id && idle >= 60000) {
      cache.delete(item.id);
      continue;
    }
    if (idle >= documentIdleMs) cache.delete(item.id);
  }
  const evictable = [...cache.values()]
    .filter(item => item.id !== protectedId && !item.inUse && !active(item) && now - item.lastUsed >= 60000)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const item of evictable) {
    if (cache.size <= limit) break;
    cache.delete(item.id);
  }
}
