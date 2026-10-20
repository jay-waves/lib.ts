import test from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkPositionKey, bookmarkMatchesRequest } from '../web/bookmarks/bookmark-position.mjs';

test('legacy file bookmarks share the first-line identity', () => {
  assert.equal(bookmarkPositionKey({}), bookmarkPositionKey({ line: 1 }));
});

test('only the navigation target is selected, regardless of subsequent scrolling', () => {
  const bookmarks = [{ path: 'a', line: 1 }, { path: 'a', line: 12 }, { path: 'b', line: 12 }];
  assert.deepEqual(bookmarks.map(item => bookmarkMatchesRequest(item, { path: 'a', line: 12 })), [false, true, false]);
  assert.ok(bookmarks.every(item => !bookmarkMatchesRequest(item, { path: 'a' })));
});

test('page bookmarks compare coordinates independent of object property order', () => {
  const bookmark = { path: 'a', page: { index: 2, x: 0.5, y: 0.25 } };
  assert.ok(bookmarkMatchesRequest(bookmark, { path: 'a', page: { y: 0.25, x: 0.5, index: 2 } }));
  assert.equal(bookmarkMatchesRequest(bookmark, { path: 'a', page: { index: 2, x: 0.5, y: 0.75 } }), false);
});
