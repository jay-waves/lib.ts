import { READING_RECORD_LIMIT, READING_FLUSH_INTERVAL } from './reading-policy.mjs';

export function readingKey(repo, path) { return `library-reading:${repo || 'default'}:${path}`; }

const positions = new Map();
const dirty = new Map();
let loaded, endpoint, syncTimer, syncing;
function scheduleSync() {
  if (!endpoint || !dirty.size || syncTimer !== undefined) return;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncReadingPositions().catch(() => {}).finally(scheduleSync);
  }, READING_FLUSH_INTERVAL);
  syncTimer?.unref?.();
}
function trimPositions() {
  while (positions.size > READING_RECORD_LIMIT) {
    const key = positions.keys().next().value;
    positions.delete(key);
    dirty.delete(key.slice(key.indexOf(':', 'library-reading:'.length) + 1));
  }
}
export function readPosition(key, storage) {
  if (!storage) return positions.get(key) || {};
  try { return JSON.parse(storage.getItem(key) || '{}'); } catch { return {}; }
}
export async function loadPosition(key, apiBase, path) {
  endpoint = `${apiBase}/reading`;
  if (!loaded) loaded = (async () => {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const saved = await response.json();
    const prefix = key.slice(0, -path.length);
    for (const [file, position] of Object.entries(saved)) positions.set(prefix + file, position);
    // Old tab-local state is migrated with the next repository/exit sync.
    try {
      const storage = globalThis.sessionStorage;
      for (let index = 0; index < storage.length; index++) {
        const oldKey = storage.key(index);
        if (oldKey.startsWith(prefix)) {
          const position = { ...positions.get(oldKey), ...JSON.parse(storage.getItem(oldKey)) };
          positions.set(oldKey, position);
          dirty.set(oldKey.slice(prefix.length), { position, legacyKey: oldKey });
        }
      }
    } catch { /* Browser storage can be unavailable. */ }
  })().catch(() => { loaded = undefined; });
  await loaded;
  trimPositions(); scheduleSync();
  return readPosition(key);
}
export async function syncReadingPositions(exiting = false) {
  if (syncing && !exiting) { await syncing; if (dirty.size) return syncReadingPositions(); return; }
  if (!endpoint || !dirty.size) return;
  if (syncTimer !== undefined) { clearTimeout(syncTimer); syncTimer = undefined; }
  const batch = new Map(dirty);
  const operation = (async () => {
    const response = await fetch(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positions: Object.fromEntries([...batch].map(([path, entry]) => [path, entry.position])) }),
      keepalive: exiting });
    if (!response.ok) throw new Error(`Reading state sync failed: HTTP ${response.status}`);
    for (const [path, entry] of batch) {
      if (dirty.get(path) === entry) dirty.delete(path);
      if (entry.legacyKey) { try { globalThis.sessionStorage.removeItem(entry.legacyKey); } catch {} }
    }
  })();
  if (!exiting) syncing = operation;
  try { await operation; }
  finally { if (syncing === operation) syncing = undefined; scheduleSync(); }
}
export function savePosition(key, updates, storage) {
  const next = { ...readPosition(key, storage), ...updates };
  if (storage) {
    try { storage.setItem(key, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  } else {
    positions.delete(key); positions.set(key, next);
    // Keys contain the page base followed by the repository-relative path.
    const prefix = key.indexOf(':', 'library-reading:'.length);
    const path = key.slice(prefix + 1);
    dirty.set(path, { position: { ...dirty.get(path)?.position, ...updates }, legacyKey: dirty.get(path)?.legacyKey });
    trimPositions(); scheduleSync();
  }
  return next;
}

// Pages are laid out vertically in DOM order, including unloaded placeholders.
export function pagePosition(panel, x, y) {
  const pages = panel.querySelectorAll('div.typst-page[data-page], .pdf-page');
  let nearest, distance = Infinity;
  const consider = (index, rect) => {
    const next = Math.max(rect.top - y, y - rect.bottom, 0);
    if (rect.width && rect.height && (next < distance || (next === distance && index < nearest.index))) {
      nearest = { index, x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
      distance = next;
    }
  };
  let low = 0, high = pages.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const rect = pages[middle].getBoundingClientRect();
    if (!rect.width || !rect.height) {
      // Hidden/degenerate pages do not guarantee ordered bounds. Preserve the
      // old behavior for that exceptional case without caching stale geometry.
      for (let index = 0; index < pages.length; index++) consider(index, pages[index].getBoundingClientRect());
      return nearest;
    }
    consider(middle, rect);
    if (rect.bottom < y) low = middle + 1;
    else high = middle;
  }
  // In a gap, the preceding page may be closer; ties favor the earlier page.
  if (low > 0) consider(low - 1, pages[low - 1].getBoundingClientRect());
  return nearest;
}

export function restorePagePosition(panel, saved, x, y) {
  const page = panel.querySelectorAll('div.typst-page[data-page], .pdf-page')[saved?.index];
  if (!page) return;
  const rect = page.getBoundingClientRect();
  panel.scrollBy({ left: rect.left + saved.x * rect.width - x,
    top: rect.top + saved.y * rect.height - y, behavior: 'instant' });
}
