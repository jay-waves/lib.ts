import { gallerySortOptions } from './gallery/gallery-images.ts';
import { gallerySize } from './gallery/gallery-zoom.mjs';

const storageKey = repository => `library-gallery:${repository}`;
const normalizePath = path => (path || '').split('/').filter(Boolean).join('/');

/** @typedef {{ gallery?: boolean, rows?: boolean, recursive?: boolean, autoplayVideos?: boolean, showHidden?: boolean }} RepositoryDisplayState */
/** @typedef {{ sort?: import('./gallery/gallery-images.ts').DirectorySort, width?: number, scrollTop?: number }} DirectoryState */

/** @returns {RepositoryDisplayState} */
function displayState(value) {
  if (typeof value === 'boolean') return { gallery: value }; // Previous storage format.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(['gallery', 'rows', 'recursive', 'autoplayVideos', 'showHidden']
    .filter(key => typeof value[key] === 'boolean').map(key => [key, value[key]]));
}

/** @returns {DirectoryState} */
function directoryState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const state = {};
  if (typeof value.sort === 'string' && Object.hasOwn(gallerySortOptions, value.sort)) state.sort = value.sort;
  if (Number.isFinite(value.width) && value.width >= gallerySize.min && value.width <= gallerySize.max) state.width = value.width;
  if (Number.isFinite(value.scrollTop) && value.scrollTop >= 0) state.scrollTop = value.scrollTop;
  return state;
}

function readStates(repository, storage) {
  let value;
  try { value = JSON.parse(storage.getItem(storageKey(repository))); }
  catch { return []; }
  return Array.isArray(value) ? value.filter(entry => Array.isArray(entry)
    && typeof entry[0] === 'string').map(([path, state]) => [normalizePath(path), {
      ...(normalizePath(path) === '' ? displayState(state) : {}), ...directoryState(state),
    }]) : [];
}

function readState(repository, path, storage) {
  try {
    storage ??= globalThis.localStorage;
    return new Map(readStates(repository, storage)).get(normalizePath(path));
  } catch { return {}; }
}

function saveState(repository, path, patch, storage) {
  try {
    storage ??= globalThis.localStorage;
    const states = new Map(readStates(repository, storage));
    const key = normalizePath(path);
    const previous = states.get(key) ?? {};
    const next = { ...previous, ...patch };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    states.set(key, next);
    storage.setItem(storageKey(repository), JSON.stringify([...states]));
  } catch { /* Browsing remains usable when browser storage is unavailable. */ }
}

export function readRepositoryDisplayState(repository, storage = undefined) {
  return displayState(readState(repository, '', storage));
}

/** @param {RepositoryDisplayState} patch */
export function saveRepositoryDisplayState(repository, patch, storage = undefined) {
  saveState(repository, '', displayState(patch), storage);
}

export function readDirectoryState(repository, path, storage = undefined) {
  return directoryState(readState(repository, path, storage));
}

/** @param {DirectoryState} patch */
export function saveDirectoryState(repository, path, patch, storage = undefined) {
  saveState(repository, path, directoryState(patch), storage);
}
