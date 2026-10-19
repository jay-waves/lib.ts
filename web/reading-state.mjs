// Positions are local to this browser. Keep only 100 recent files and coalesce
// frequent captures into one synchronous storage write per 500 ms.
const READING_RECORD_LIMIT = 100;
const READING_WRITE_INTERVAL = 500;
const READING_CACHE_KEY = 'library-reading-cache';
const positions = new Map();
let hydrated = false, changed = false, writeTimer;
const isPosition = value => value && typeof value === 'object' && !Array.isArray(value);

export function readingKey(repo, path) { return `library-reading:${repo || 'default'}:${path}`; }

function trimPositions() {
  while (positions.size > READING_RECORD_LIMIT) positions.delete(positions.keys().next().value);
}
function scheduleWrite() {
  if (writeTimer !== undefined) return;
  writeTimer = setTimeout(flushReadingPositions, READING_WRITE_INTERVAL);
  writeTimer?.unref?.();
}
function hydratePositions() {
  if (hydrated) return;
  hydrated = true;
  try {
    const cached = JSON.parse(globalThis.localStorage?.getItem(READING_CACHE_KEY) || '{}');
    for (const [key, value] of (cached.positions || []).slice(-READING_RECORD_LIMIT)) {
      if (typeof key === 'string' && key.startsWith('library-reading:') && isPosition(value)) positions.set(key, value);
    }
  } catch { /* Corrupt or unavailable storage falls back to memory. */ }
  trimPositions();
}
export function readPosition(key, storage) {
  if (!storage) { hydratePositions(); return positions.get(key) || {}; }
  try { const value = JSON.parse(storage.getItem(key) || '{}'); return isPosition(value) ? value : {}; }
  catch { return {}; }
}
export function savePosition(key, updates, storage) {
  const previous = readPosition(key, storage);
  const next = { ...previous, ...updates };
  if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
  if (storage) {
    try { storage.setItem(key, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
  } else {
    positions.delete(key); positions.set(key, next);
    trimPositions(); changed = true; scheduleWrite();
  }
  return next;
}
export function flushReadingPositions() {
  clearTimeout(writeTimer); writeTimer = undefined;
  if (!changed) return;
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;
    storage.setItem(READING_CACHE_KEY, JSON.stringify({ positions: [...positions] }));
    changed = false;
  } catch { /* Reading continues in memory if storage is unavailable or full. */ }
}

// Pages are laid out vertically in DOM order, including unloaded placeholders.
export function pagePosition(panel, x, y) {
  const pages = panel.querySelectorAll('.document-page[data-page]');
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
  const page = panel.querySelectorAll('.document-page[data-page]')[saved?.index];
  if (!page) return;
  const rect = page.getBoundingClientRect();
  const horizontal = panel.querySelector?.('.document-viewer') || panel;
  const left = rect.left + saved.x * rect.width - x;
  if (horizontal !== panel) horizontal.scrollBy({ left, behavior: 'instant' });
  panel.scrollBy({ left: horizontal === panel ? left : 0,
    top: rect.top + saved.y * rect.height - y, behavior: 'instant' });
}
