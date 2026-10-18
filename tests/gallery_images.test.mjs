import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryImages, isGalleryVideo, sortDirectoryNodes } from '../web/gallery-images.ts';

const file = (name, path = name) => ({ name, path, type: 'file', modified: '' });

test('gallery includes native video candidates but leaves other containers out', () => {
  const videos = ['clip.MP4', 'clip.webm', 'clip.m4v', 'clip.ogv'].map(name => file(name));
  assert.deepEqual(galleryImages([...videos, file('clip.mkv'), file('clip.avi')], false), videos);
  assert.equal(isGalleryVideo('clip.MP4'), true);
  assert.equal(isGalleryVideo('clip.mp4.png'), false);
});

test('directory sorting supports natural names and modification times without mutating the tree', () => {
  const older = { ...file('photo10.png'), modified: '2026-01-01T00:00:00Z' };
  const newer = { ...file('Photo2.png'), modified: '2026-02-01T00:00:00Z' };
  const unknown = file('other.png');
  const nodes = [older, newer, unknown];
  assert.deepEqual(sortDirectoryNodes(nodes, 'name-asc'), [unknown, newer, older]);
  assert.deepEqual(sortDirectoryNodes(nodes, 'name-desc'), [older, newer, unknown]);
  assert.deepEqual(sortDirectoryNodes(nodes, 'time-asc'), [older, newer, unknown]);
  assert.deepEqual(sortDirectoryNodes(nodes, 'time-desc'), [newer, older, unknown]);
  assert.deepEqual(nodes, [older, newer, unknown]);
});

test('gallery selects image filenames case-insensitively without treating folders as images', () => {
  const photo = file('Photo.JPG');
  const svg = file('中文 #1.svg');
  const nodes = [photo, file('notes.md'), svg, file('image.png.txt'),
    { name: 'folder.png', path: 'folder.png', type: 'directory', modified: '', children: [file('nested.webp')] }];
  assert.deepEqual(galleryImages(nodes, false), [photo, svg]);
  assert.equal(nodes.length, 5);
});

test('recursive gallery preserves paths and tree order, handles empty and missing children', () => {
  const first = file('same.png', 'first/same.png');
  const second = file('same.png', 'second/deep/same.png');
  const directory = (path, children) => ({ name: path, path, type: 'directory', modified: '', children });
  const nodes = [directory('first', [first]), directory('second', [directory('deep', [second])]), directory('empty', [])];
  assert.deepEqual(galleryImages(nodes, true), [first, second]);
  assert.deepEqual(galleryImages([directory('unloaded')], true), []);
  assert.deepEqual(galleryImages([], false), []);
});
