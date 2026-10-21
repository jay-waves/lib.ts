import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentMediaPath, mediaNavigationDirection } from './media-navigation.mjs';

test('media navigation follows sibling order and skips other files and directories', () => {
  const nodes = [
    { type: 'file', name: 'photo.jpg', path: 'album/photo.jpg' },
    { type: 'directory', name: 'other', path: 'album/other', children: [] },
    { type: 'file', name: 'notes.txt', path: 'album/notes.txt' },
    { type: 'file', name: 'clip.mp4', path: 'album/clip.mp4' },
    { type: 'file', name: 'stream.ts', path: 'album/stream.ts', transportStream: true },
  ];
  assert.equal(adjacentMediaPath(nodes, 'album/photo.jpg', 1), 'album/clip.mp4');
  assert.equal(adjacentMediaPath(nodes, 'album/clip.mp4', -1), 'album/photo.jpg');
  assert.equal(adjacentMediaPath(nodes, 'album/clip.mp4', 1), 'album/stream.ts');
  assert.equal(adjacentMediaPath(nodes, 'album/photo.jpg', -1), undefined);
  assert.equal(adjacentMediaPath(nodes, 'album/stream.ts', 1), undefined);
  assert.equal(adjacentMediaPath(nodes, 'missing.jpg', 1), undefined);
  assert.equal(adjacentMediaPath(undefined, 'missing.jpg', 1), undefined);
});

test('video controls share file navigation while menus and editable fields keep their keys', () => {
  const control = { closest: selector => selector === '.library-video' || selector.startsWith('button,') ? {} : null };
  assert.equal(mediaNavigationDirection({ key: 'ArrowUp', target: control }), -1);
  assert.equal(mediaNavigationDirection({ key: 'ArrowDown', target: control }), 1);
  assert.equal(mediaNavigationDirection({ key: 'ArrowRight', target: control }), 0);
  const menu = { closest: selector => selector.includes('[role="menu"]') ? {} : null };
  assert.equal(mediaNavigationDirection({ key: 'ArrowDown', target: menu }), 0);
});

test('only plain, non-repeated arrows outside interactive controls navigate', () => {
  assert.equal(mediaNavigationDirection({ key: 'ArrowUp' }), -1);
  assert.equal(mediaNavigationDirection({ key: 'ArrowDown' }), 1);
  assert.equal(mediaNavigationDirection({ key: 'ArrowLeft' }), 0);
  assert.equal(mediaNavigationDirection({ key: '<', shiftKey: true }), -1);
  assert.equal(mediaNavigationDirection({ key: '>', shiftKey: true }), 1);
  assert.equal(mediaNavigationDirection({ key: '<' }), -1);
  assert.equal(mediaNavigationDirection({ key: '>' }), 1);
  assert.equal(mediaNavigationDirection({ key: ',' }), 0);
  assert.equal(mediaNavigationDirection({ key: '.' }), 0);
  assert.equal(mediaNavigationDirection({ key: '>', ctrlKey: true, shiftKey: true }), 0);
  for (const flag of ['defaultPrevented', 'repeat', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.equal(mediaNavigationDirection({ key: 'ArrowDown', [flag]: true }), 0);
  }
  assert.equal(mediaNavigationDirection({ key: 'ArrowDown', target: { isContentEditable: true } }), 0);
  assert.equal(mediaNavigationDirection({ key: 'ArrowDown', target: { closest: () => ({}) } }), 0);
});
