import test from 'node:test';
import assert from 'node:assert/strict';
import { directorySortOptions, galleryImages, isGalleryVideo, isVideoMedia, isBrowserVideo, mediaKey, sortDirectoryNodes } from '../web/gallery/gallery-images.ts';

const file = (name, path = name) => ({ name, path, type: 'file', modified: '' });

test('gallery includes native and external video candidates', () => {
  const videos = ['clip.MP4', 'clip.webm', 'clip.m4v', 'clip.MOV', 'clip.ogv', 'clip.mkv', 'clip.avi'].map(name => file(name));
  assert.deepEqual(galleryImages([...videos, file('notes.txt')], false), videos);
  assert.equal(isGalleryVideo('clip.MP4'), true);
  assert.equal(isGalleryVideo('live-photo.mov'), true);
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

test('capture date sorting uses EXIF dates and falls back to modification times', () => {
  const first = { ...file('first.jpg'), modified: '2026-10-01T00:00:00Z' };
  const last = { ...file('last.jpg'), modified: '2026-01-01T00:00:00Z' };
  const fallback = { ...file('fallback.png'), modified: '2026-05-01T00:00:00Z' };
  const unknown = file('unknown.svg');
  const dates = {
    [mediaKey(first)]: Date.parse('2026-02-01T00:00:00Z'),
    [mediaKey(last)]: Date.parse('2026-09-01T00:00:00Z'),
    [mediaKey(fallback)]: null,
  };
  const nodes = [last, unknown, fallback, first];
  assert.deepEqual(sortDirectoryNodes(nodes, 'taken-asc', dates), [first, fallback, last, unknown]);
  assert.deepEqual(sortDirectoryNodes(nodes, 'taken-desc', dates), [last, fallback, first, unknown]);
  assert.deepEqual(sortDirectoryNodes(nodes, 'time-asc', dates), [last, fallback, first, unknown]);
  assert.deepEqual(nodes, [last, unknown, fallback, first]);
});

test('capture dates are revision-specific and ties use natural names', () => {
  const a = { ...file('photo2.jpeg'), modified: '2026-05-01T00:00:00Z', liveVideo: file('photo2.mov') };
  const b = { ...file('photo10.jpeg'), modified: a.modified };
  const dates = { [mediaKey(a)]: 0, [mediaKey(b)]: 0 };
  assert.deepEqual(sortDirectoryNodes([b, a], 'taken-desc', dates), [a, b]);
  const updated = { ...a, modified: '2026-10-01T00:00:00Z' };
  assert.deepEqual(sortDirectoryNodes([b, updated], 'taken-asc', dates), [b, updated]);
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

test('MOV finds a same-name JPEG and merges into a Live card without mutating files', () => {
  const photo = file('IMG_1234.JPEG');
  const video = { ...file('IMG_1234.MOV'), modified: 'video-revision' };
  for (const nodes of [[video, photo], [photo, video]]) {
    const result = galleryImages(nodes, false);
    assert.deepEqual(result, [{ ...photo, liveVideo: video }]);
    assert.equal(result[0].liveVideo.modified, 'video-revision');
    assert.equal(photo.liveVideo, undefined);
  }
  assert.equal(sortDirectoryNodes(galleryImages([video, photo], false), 'name-asc')[0].liveVideo, video);
});

test('JPG, HEIC and HEIF pair with same-stem MOV regardless of case or file order', () => {
  for (const [photoName, videoName] of [
    ['IMG_0061.JPG', 'IMG_0061.MOV'],
    ['img_0061.jpg', 'IMG_0061.mov'],
    ['IMG_0061.HEIC', 'IMG_0061.MOV'],
    ['img_0061.heic', 'IMG_0061.mov'],
    ['IMG_0061.HEIF', 'IMG_0061.MOV'],
    ['IMG_0061.HEIC.heic', 'IMG_0061.HEIC.mov'],
  ]) {
    const photo = file(photoName), video = file(videoName);
    for (const nodes of [[photo, video], [video, photo]]) {
      assert.deepEqual(galleryImages(nodes, false), [{ ...photo, liveVideo: video }]);
      assert.equal(photo.liveVideo, undefined);
    }
  }
});

test('HEIC Live pairs remain scoped to their directory and unmatched MOV stays visible', () => {
  const photo = file('same.HEIC', 'photos/same.HEIC');
  const video = file('same.MOV', 'videos/same.MOV');
  const directory = (name, children) => ({ name, path: name, type: 'directory', modified: '', children });
  assert.deepEqual(galleryImages([directory('photos', [photo]), directory('videos', [video])], true), [photo, video]);
  const sibling = file('same.MOV', 'photos/same.MOV');
  const unmatched = file('other.MOV', 'photos/other.MOV');
  assert.deepEqual(galleryImages([directory('photos', [photo, sibling, unmatched])], true),
    [{ ...photo, liveVideo: sibling }, unmatched]);
});

test('unmatched files stay separate and MOV only pairs with supported photos in its own directory', () => {
  const jpeg = file('still.jpeg');
  const mov = file('motion.mov');
  const jpg = file('other.jpg');
  assert.deepEqual(galleryImages([jpeg, mov, jpg], false), [jpeg, mov, jpg]);

  const photo = file('same.jpeg', 'photos/same.jpeg');
  const video = file('same.mov', 'videos/same.mov');
  const directory = (name, children) => ({ name, path: name, type: 'directory', modified: '', children });
  assert.deepEqual(galleryImages([directory('photos', [photo]), directory('videos', [video])], true), [photo, video]);
});

test('folders stay first for every list sort while each group follows the chosen order', () => {
  const nodes = [
    { name: 'a.txt', type: 'file', modified: '2026-01-01' },
    { name: 'b-dir', type: 'directory', modified: '2026-02-01' },
    { name: 'b.txt', type: 'file', modified: '2026-02-01' },
    { name: 'a-dir', type: 'directory', modified: '2026-01-01' },
  ].map(node => ({ ...node, path: node.name }));
  for (const sort of Object.keys(directorySortOptions)) {
    const result = sortDirectoryNodes(nodes, sort);
    assert.deepEqual(result.map(node => node.type), ['directory', 'directory', 'file', 'file']);
    const first = sort.endsWith('desc') ? 'b' : 'a';
    assert.equal(result[0].name, `${first}-dir`);
    assert.equal(result[2].name, `${first}.txt`);
  }
  assert.equal(nodes[0].name, 'a.txt');
});

test('TS gallery candidates require content detection, preserving TypeScript files', () => {
  const source = file('source.ts');
  const video = { ...file('clip.TS'), transportStream: true };
  assert.deepEqual(galleryImages([source, video], false), [video]);
  assert.equal(isVideoMedia(source), false);
  assert.equal(isVideoMedia({ name: 'clip.ts', mime: 'video/mp2t' }), true);
});

test('TS and external containers have covers but cannot autoplay in the browser', () => {
  assert.equal(isBrowserVideo({ name: 'clip.ts', transportStream: true }), false);
  assert.equal(isBrowserVideo({ name: 'clip.mp4', mime: 'video/mp2t' }), false);
  for (const name of ['clip.mkv', 'clip.avi', 'clip.m2ts']) {
    assert.equal(isVideoMedia({ name }), true);
    assert.equal(isBrowserVideo({ name }), false);
  }
  for (const name of ['clip.MOV', 'clip.mp4', 'clip.webm']) {
    assert.equal(isBrowserVideo({ name }), true);
  }
});


test('server gallery descriptions override filename hints', () => {
  assert.equal(isVideoMedia({ name: 'misnamed.mp4', media: null }), false);
  assert.equal(isVideoMedia({ name: 'renamed.bin', media: 'video' }), true);
  assert.equal(isBrowserVideo({ name: 'misnamed.mp4', playable: false }), false);
  assert.equal(isBrowserVideo({ name: 'renamed.bin', playable: true }), true);
});

test('JPG Live pairs stay scoped to their directory and unpaired JPG remains visible', () => {
  const photo = file('same.JPG', 'photos/same.JPG');
  const other = file('other.jpg', 'photos/other.jpg');
  const video = file('same.MOV', 'videos/same.MOV');
  const directory = (name, children) => ({ name, path: name, type: 'directory', modified: '', children });
  assert.deepEqual(galleryImages([directory('photos', [photo, other]), directory('videos', [video])], true), [photo, other, video]);
  const sibling = file('same.mov', 'photos/same.mov');
  assert.deepEqual(galleryImages([photo, sibling, other], false), [{ ...photo, liveVideo: sibling }, other]);
});
