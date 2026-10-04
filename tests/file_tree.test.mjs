import test from 'node:test';
import assert from 'node:assert/strict';
import { sortFileTree, filterBookmarkedTree, isPlainTreeActivation, fileTreeForView, fileListFromPaths } from '../library/file-tree.mjs';

test('modified sorting is recursive, directories first, newest first and leaves the source intact', () => {
  const older = { name: 'a.md', type: 'file', modified: '2026-01-01T00:00:00Z' };
  const newer = { name: 'z.md', type: 'file', modified: '2026-02-01T00:00:00Z' };
  const directory = { name: 'folder', type: 'directory', children: [older, newer] };
  const nodes = [older, newer, directory];
  const result = sortFileTree(nodes);
  assert.deepEqual(result.map(node => node.name), ['folder', 'z.md', 'a.md']);
  assert.deepEqual(result[0].children.map(node => node.name), ['z.md', 'a.md']);
  assert.deepEqual(nodes.map(node => node.name), ['a.md', 'z.md', 'folder']);
  assert.deepEqual(directory.children, [older, newer]);
});

test('missing timestamps and ties fall back to numeric name order', () => {
  const nodes = ['file10', 'file2', 'file1'].map(name => ({ name, type: 'file' }));
  assert.deepEqual(sortFileTree(nodes).map(node => node.name), ['file1', 'file2', 'file10']);
  assert.deepEqual(sortFileTree(), []);
});

test('tree navigation intercepts only unmodified primary clicks and keyboard activation', () => {
  assert.equal(isPlainTreeActivation({ button: 0 }), true);
  assert.equal(isPlainTreeActivation({ key: 'Enter' }), true);
  for (const event of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true },
    { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    assert.equal(isPlainTreeActivation(event), false);
  }
});


test('bookmark filtering keeps bookmarked files and ancestor folders, without modifying the source tree', () => {
  const nodes = [
    { name: 'docs', path: 'docs', type: 'directory', children: [
      { name: 'notes', path: 'docs/notes', type: 'directory', children: [
        { name: 'keep.md', path: 'docs/notes/keep.md', type: 'file' },
        { name: 'other.md', path: 'docs/notes/other.md', type: 'file' },
      ] },
      { name: 'unused', path: 'docs/unused', type: 'directory', children: [] },
    ] },
    { name: 'book.pdf', path: 'book.pdf', type: 'file' },
    { name: 'other.txt', path: 'other.txt', type: 'file' },
  ];
  const original = structuredClone(nodes);
  const result = filterBookmarkedTree(nodes, [{ path: 'docs/notes/keep.md' }, { path: 'book.pdf' }]);
  assert.deepEqual(result.map(node => node.path), ['docs', 'book.pdf']);
  assert.deepEqual(result[0].children.map(node => node.path), ['docs/notes']);
  assert.deepEqual(result[0].children[0].children.map(node => node.path), ['docs/notes/keep.md']);
  assert.deepEqual(nodes, original);
});

test('bookmark filtering handles missing files, empty folders and exact paths without leaking siblings', () => {
  const nodes = [{ name: 'folder', path: 'folder', type: 'directory', children: [
    { name: 'a.md', path: 'folder/a.md', type: 'file' },
    { name: 'a.md.bak', path: 'folder/a.md.bak', type: 'file' },
  ] }];
  assert.deepEqual(filterBookmarkedTree(nodes, []), []);
  assert.deepEqual(filterBookmarkedTree(nodes, [{ path: 'missing.md' }, { path: 'folder' }]), []);
  assert.deepEqual(filterBookmarkedTree(), []);
  const result = filterBookmarkedTree(nodes, [{ path: 'folder/a.md' }, { path: 'folder/a.md' }]);
  assert.deepEqual(result[0].children.map(node => node.path), ['folder/a.md']);
});


test('Bookmarks preserve ordinary folder hierarchy and real file paths', () => {
  const file = path => ({ name: path.split('/').at(-1), path, type: 'file' });
  const folder = (path, children) => ({ name: path.split('/').at(-1), path, type: 'directory', children });
  const nodes = [folder('math', [folder('math/linalg', [file('math/linalg/note.md'), file('math/linalg/other.md')])]),
    folder('books', [file('books/note.md')]), file('root.md')];
  const original = structuredClone(nodes);
  const bookmarks = ['math/linalg/note.md', 'books/note.md', 'missing.md'].map(path => ({ path }));
  const result = fileTreeForView(nodes, { bookmarksOnly: true, bookmarks, query: 'unrelated' });
  assert.deepEqual(result.map(node => node.name), ['math', 'books']);
  assert.equal(result[0].children[0].children[0].path, 'math/linalg/note.md');
  assert.equal(result[1].children[0].path, 'books/note.md');
  assert.equal(result[0].children[0].name, 'linalg');
  assert.equal(result[0].children[0].children.length, 1);
  assert.deepEqual(nodes, original);
  assert.equal(fileTreeForView(nodes)[0].type, 'directory');
});

test('History flattens paths in strict visit order and retains same-named and missing files', () => {
  const paths = ['math/linalg/note.md', 'root.md', 'books/note.md', 'math/linalg/old.md', 'math/linalg/note.md'];
  const nodes = fileListFromPaths(paths);
  assert.deepEqual(nodes.map(node => node.path), paths.slice(0, 4));
  assert.deepEqual(nodes.map(node => node.name), ['note.md', 'root.md', 'note.md', 'old.md']);
  assert.ok(nodes.every(node => node.type === 'file' && !node.children));
  assert.deepEqual(fileListFromPaths(['a/b/c.md']), [{ name: 'c.md', path: 'a/b/c.md', type: 'file' }]);
  assert.deepEqual(fileListFromPaths(), []);
});
