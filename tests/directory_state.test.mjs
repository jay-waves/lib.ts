import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readDirectoryState, saveDirectoryState, readRepositoryDisplayState, saveRepositoryDisplayState,
} from '../web/directory-state.mjs';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('display options share one repository scope and ignore old per-directory overrides', () => {
  const storage = memoryStorage();
  storage.setItem('library-gallery:repo', JSON.stringify([
    ['', { gallery: true }], ['photos', { gallery: false, recursive: false }],
  ]));
  const display = { gallery: true, showHidden: true, rows: true, recursive: true, autoplayVideos: true };
  saveRepositoryDisplayState('repo', display, storage);
  assert.deepEqual(readRepositoryDisplayState('repo', storage), display);
  assert.deepEqual(readDirectoryState('repo', 'photos', storage), {});
  assert.deepEqual(readRepositoryDisplayState('other-repo', storage), {});
});

test('sort, zoom and scroll persist independently for each directory, without inheritance', () => {
  const storage = memoryStorage();
  const root = { sort: 'name-desc', width: 180, scrollTop: 400 };
  const photos = { sort: 'taken-desc', width: 320, scrollTop: 1200 };
  saveDirectoryState('repo', '', root, storage);
  saveDirectoryState('repo', 'photos', photos, storage);
  saveDirectoryState('repo', 'docs', { sort: 'time-asc', width: 220, scrollTop: 0 }, storage);
  assert.deepEqual(readDirectoryState('repo', 'photos', storage), photos);
  assert.deepEqual(readDirectoryState('repo', '', storage), root);
  assert.deepEqual(readDirectoryState('repo', 'photos/subfolder', storage), {});
  assert.deepEqual(readDirectoryState('other-repo', 'photos', storage), {});
});

test('repository and directory patches preserve each other, including the root directory', () => {
  const storage = memoryStorage();
  saveDirectoryState('repo', '', { sort: 'time-desc', width: 260, scrollTop: 800 }, storage);
  saveRepositoryDisplayState('repo', { gallery: true, rows: true }, storage);
  saveDirectoryState('repo', '', { scrollTop: 1000 }, storage);
  saveRepositoryDisplayState('repo', { showHidden: true, rows: false }, storage);
  assert.deepEqual(readDirectoryState('repo', '', storage), { sort: 'time-desc', width: 260, scrollTop: 1000 });
  assert.deepEqual(readRepositoryDisplayState('repo', storage), { gallery: true, rows: false, showHidden: true });
});

test('invalid directory values are ignored without losing existing preferences', () => {
  const storage = memoryStorage();
  const saved = { sort: 'time-desc', width: 260, scrollTop: 800 };
  saveDirectoryState('repo', 'docs', saved, storage);
  saveDirectoryState('repo', 'docs', { sort: 'invalid', width: 0, scrollTop: -1 }, storage);
  saveDirectoryState('repo', 'docs', { width: Infinity, scrollTop: NaN }, storage);
  assert.deepEqual(readDirectoryState('repo', 'docs', storage), saved);
});

test('writes discard legacy directory display overrides and normalize directory paths', () => {
  const storage = memoryStorage();
  storage.setItem('library-gallery:repo', JSON.stringify([
    ['', { gallery: true }], ['/photos/', { gallery: false, recursive: true, sort: 'taken-desc' }],
  ]));
  saveDirectoryState('repo', 'photos', { scrollTop: 300 }, storage);
  const states = new Map(JSON.parse(storage.getItem('library-gallery:repo')));
  assert.deepEqual(states.get('photos'), { sort: 'taken-desc', scrollTop: 300 });
  assert.deepEqual(readRepositoryDisplayState('repo', storage), { gallery: true });
  assert.equal(readDirectoryState('repo', '/photos/', storage).scrollTop, 300);
});

test('unchanged preference patches do not rewrite browser storage', () => {
  const storage = memoryStorage();
  saveDirectoryState('repo', 'docs', { sort: 'name-desc', width: 260 }, storage);
  let writes = 0;
  storage.setItem = () => { writes++; };
  saveDirectoryState('repo', 'docs', { sort: 'name-desc', width: 260 }, storage);
  saveDirectoryState('repo', 'docs', {}, storage);
  assert.equal(writes, 0);
});

test('legacy repository settings and unavailable storage remain supported', () => {
  const storage = memoryStorage();
  storage.setItem('library-gallery:repo', JSON.stringify([['', true], ['photos', { sort: 'taken-asc' }]]));
  assert.deepEqual(readRepositoryDisplayState('repo', storage), { gallery: true });
  assert.deepEqual(readDirectoryState('repo', 'photos', storage), { sort: 'taken-asc' });
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readDirectoryState('repo', '', unavailable), {});
  assert.deepEqual(readRepositoryDisplayState('repo', unavailable), {});
  assert.doesNotThrow(() => saveDirectoryState('repo', '', { sort: 'name-asc' }, unavailable));
  assert.doesNotThrow(() => saveRepositoryDisplayState('repo', { gallery: true }, unavailable));
});

test('malformed storage recovers on save and invalid display values are ignored', () => {
  const storage = memoryStorage();
  storage.setItem('library-gallery:repo', '{');
  assert.deepEqual(readDirectoryState('repo', 'docs', storage), {});
  assert.deepEqual(readRepositoryDisplayState('repo', storage), {});
  saveRepositoryDisplayState('repo', { gallery: true }, storage);
  saveRepositoryDisplayState('repo', { gallery: 'false', rows: 1, unknown: true }, storage);
  assert.deepEqual(readRepositoryDisplayState('repo', storage), { gallery: true });
});
