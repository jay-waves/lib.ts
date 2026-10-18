import test from 'node:test';
import assert from 'node:assert/strict';
import { readDirectoryGallery, saveDirectoryGallery, readDirectoryGalleryState, saveDirectoryGalleryState } from '../web/directory-state.mjs';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('gallery persists by repository and inherits through directory boundaries', () => {
  const saved = storage();
  saveDirectoryGallery('/repo/photos', 'albums', true, saved);
  assert.equal(readDirectoryGallery('/repo/photos', 'albums', saved), true);
  assert.equal(readDirectoryGallery('/repo/photos', 'albums/2026/trip', saved), true);
  assert.equal(readDirectoryGallery('/repo/photos', 'albums-other', saved), undefined);
  assert.equal(readDirectoryGallery('/repo/work', 'albums', saved), undefined);
  assert.equal(readDirectoryGallery('/repo/photos', '', saved), undefined);
});

test('nearest explicit choice overrides ancestors, including the root', () => {
  const saved = storage();
  saveDirectoryGallery('repo', '', true, saved);
  saveDirectoryGallery('repo', 'photos/private', false, saved);
  saveDirectoryGallery('repo', 'photos/private/shared', true, saved);
  assert.equal(readDirectoryGallery('repo', 'photos/other', saved), true);
  assert.equal(readDirectoryGallery('repo', 'photos/private/sub', saved), false);
  assert.equal(readDirectoryGallery('repo', 'photos/private/shared/sub', saved), true);
  saveDirectoryGallery('repo', 'photos/private', true, saved);
  assert.equal(readDirectoryGallery('repo', 'photos/private/sub', saved), true);
});

test('invalid or inaccessible storage does not interrupt directory navigation', () => {
  const invalid = { getItem: () => '{' };
  assert.equal(readDirectoryGallery('repo', 'photos', invalid), undefined);
  const corrupt = storage();
  corrupt.setItem('library-gallery:repo', '{');
  saveDirectoryGallery('repo', 'photos', true, corrupt);
  assert.equal(readDirectoryGallery('repo', 'photos', corrupt), true);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readDirectoryGallery('repo', '', blocked), undefined);
  assert.doesNotThrow(() => saveDirectoryGallery('repo', '', true, blocked));
});

test('gallery options persist and inherit independently without freezing unchanged ancestor options', () => {
  const saved = storage();
  saveDirectoryGalleryState('repo', 'photos', {
    gallery: true, rows: true, recursive: true, autoplayVideos: false,
  }, saved);
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos/trip', saved), {
    gallery: true, rows: true, recursive: true, autoplayVideos: false,
  });
  saveDirectoryGalleryState('repo', 'photos/trip', { rows: false }, saved);
  saveDirectoryGalleryState('repo', 'photos', { autoplayVideos: true }, saved);
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos/trip/day1', saved), {
    gallery: true, rows: false, recursive: true, autoplayVideos: true,
  });
  saveDirectoryGallery('repo', 'photos/trip', false, saved);
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos/trip', saved), {
    gallery: false, rows: false, recursive: true, autoplayVideos: true,
  });
  saveDirectoryGallery('repo', 'photos/trip', true, saved);
  assert.equal(readDirectoryGalleryState('repo', 'photos/trip', saved).rows, false);
});

test('old boolean records remain valid when options are added', () => {
  const saved = storage();
  saved.setItem('library-gallery:repo', JSON.stringify([['photos', true], ['photos/private', false]]));
  saveDirectoryGalleryState('repo', 'photos', { rows: true }, saved);
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos', saved), { gallery: true, rows: true });
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos/private', saved), { gallery: false, rows: true });
});

test('malformed option values do not override inherited settings', () => {
  const saved = storage();
  saved.setItem('library-gallery:repo', JSON.stringify([
    ['', { rows: true, autoplayVideos: false }],
    ['photos', { rows: 'false', autoplayVideos: true, recursive: 1, unknown: true }],
  ]));
  assert.deepEqual(readDirectoryGalleryState('repo', 'photos', saved), { rows: true, autoplayVideos: true });
});
