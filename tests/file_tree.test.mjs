import test from 'node:test';
import assert from 'node:assert/strict';
import { sortFileTree, filterBookmarkedTree, isPlainTreeActivation, fileTreeForView, fileListFromPaths, fileTreeFromPaths, unloadedDirectory, collapsedFileTreePaths } from '../web/file-tree.mjs';

test('collapse all resets nested, unloaded and default-expanded folders across views', () => {
  const nodes = [{ path: 'docs', type: 'directory', children: [
    { path: 'docs/nested', type: 'directory' },
    { path: 'docs/readme.md', type: 'file' },
  ] }];
  const expanded = { docs: true, 'docs/nested': true, 'other/cached': true, 'history:older': true };
  const original = structuredClone(expanded);
  const collapsed = collapsedFileTreePaths(nodes, expanded, [{ id: 'older' }, { id: 'past-week' }]);
  assert.deepEqual(collapsed, {
    docs: false, 'docs/nested': false, 'other/cached': false,
    'history:older': false, 'history:past-week': false,
  });
  assert.deepEqual(expanded, original);
  assert.deepEqual(collapsedFileTreePaths(nodes, { ...collapsed, docs: true }), { ...collapsed, docs: false });
  assert.deepEqual(collapsedFileTreePaths(), {});
});

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


test('Bookmarks flatten files with real paths, preserve order and search full paths', () => {
  const file = path => ({ name: path.split('/').at(-1), path, type: 'file' });
  const folder = (path, children) => ({ name: path.split('/').at(-1), path, type: 'directory', children });
  const nodes = [folder('math', [folder('math/linalg', [file('math/linalg/note.md'), file('math/linalg/other.md')])]),
    folder('books', [file('books/note.md')]), file('root.md')];
  const original = structuredClone(nodes);
  const bookmarks = ['math/linalg/note.md', 'books/note.md', 'missing.md'].map(path => ({ path }));
  const result = fileTreeForView(nodes, { bookmarksOnly: true, bookmarks });
  assert.deepEqual(result.map(node => node.path), ['math/linalg/note.md', 'books/note.md']);
  assert.ok(result.every(node => node.type === 'file' && !node.children));
  assert.deepEqual(fileTreeForView(nodes, { bookmarksOnly: true, bookmarks, query: 'linalg' }), [result[0]]);
  assert.deepEqual(fileTreeForView(nodes, { bookmarksOnly: true, bookmarks, query: 'unrelated' }), []);
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


test('search file tree groups ancestors, preserves full paths and sorts directories first', () => {
  const paths = ['z.md', 'src/main.rs', 'src/nested/a.rs', 'docs/main.rs', 'src/main.rs', 'file10.ts', 'file2.ts'];
  const original = [...paths];
  const tree = fileTreeFromPaths(paths);
  assert.deepEqual(tree.map(node => node.path), ['docs', 'src', 'file2.ts', 'file10.ts', 'z.md']);
  assert.deepEqual(tree[1].children.map(node => node.path), ['src/nested', 'src/main.rs']);
  assert.deepEqual(tree[1].children[0].children, [{ name: 'a.rs', path: 'src/nested/a.rs', type: 'file' }]);
  assert.equal(tree[0].children[0].path, 'docs/main.rs');
  assert.deepEqual(paths, original);
  assert.deepEqual(fileTreeFromPaths([]), []);
});


test('recursive browsing distinguishes empty directories from unopened ones', () => {
  const nodes = [
    { type: 'directory', path: 'empty', children: [] },
    { type: 'directory', path: 'docs', children: [{ type: 'directory', path: 'docs/deep' }] },
    { type: 'directory', path: 'photos' },
  ];
  assert.equal(unloadedDirectory(nodes), 'docs/deep');
  nodes[1].children[0].children = [];
  assert.equal(unloadedDirectory(nodes), 'photos');
  nodes[2].children = [];
  assert.equal(unloadedDirectory(nodes), undefined);
});
