const storageKey = repository => `library-gallery:${repository}`;
const normalizePath = path => (path || '').split('/').filter(Boolean).join('/');

/** @typedef {{ gallery?: boolean, rows?: boolean, recursive?: boolean, autoplayVideos?: boolean }} GalleryState */

/** @returns {GalleryState} */
function normalizeState(value) {
  if (typeof value === 'boolean') return { gallery: value }; // Previous storage format.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(['gallery', 'rows', 'recursive', 'autoplayVideos']
    .filter(key => typeof value[key] === 'boolean').map(key => [key, value[key]]));
}

function readStates(repository, storage) {
  let value;
  try { value = JSON.parse(storage.getItem(storageKey(repository))); }
  catch { return []; }
  return Array.isArray(value) ? value.filter(entry => Array.isArray(entry)
    && typeof entry[0] === 'string').map(([path, state]) => [path, normalizeState(state)]) : [];
}

// Each option inherits independently; the closest explicit choice wins.
/** @returns {GalleryState} */
export function readDirectoryGalleryState(repository, path, storage = undefined) {
  try {
    storage ??= globalThis.localStorage;
    const states = new Map(readStates(repository, storage));
    let result = {};
    let current = normalizePath(path);
    while (true) {
      result = { ...states.get(current), ...result };
      if (!current) return result;
      current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    }
  } catch { return {}; }
}

/** @param {GalleryState} patch */
export function saveDirectoryGalleryState(repository, path, patch, storage = undefined) {
  try {
    storage ??= globalThis.localStorage;
    const states = new Map(readStates(repository, storage));
    const key = normalizePath(path);
    states.set(key, { ...states.get(key), ...normalizeState(patch) });
    storage.setItem(storageKey(repository), JSON.stringify([...states]));
  } catch { /* Gallery remains usable when browser storage is unavailable. */ }
}

export function readDirectoryGallery(repository, path, storage = undefined) {
  return readDirectoryGalleryState(repository, path, storage).gallery;
}

export function saveDirectoryGallery(repository, path, enabled, storage = undefined) {
  saveDirectoryGalleryState(repository, path, { gallery: enabled }, storage);
}
