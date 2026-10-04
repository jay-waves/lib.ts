import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createLibrarySearch } from '../library/search.mjs';
import { openRepositories } from '../library/repositories.mjs';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';
import { fileTreeForView } from '../library/file-tree.mjs';

test('Current File scans only the requested body and binds snapshots to that file', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'search-current-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'first.md'), '# First\nNEEDLE in this file\n');
  await writeFile(resolve(root, 'second.md'), '# Second\nneedle elsewhere\n');
  const search = createLibrarySearch(root);
  const query = (currentFile, extra = {}) => search(new URLSearchParams({ q: '/needle/i', scope: 'current-file', currentFile, ...extra }));
  const first = await query('first.md');
  assert.equal(first.engine, 'selected-files');
  assert.deepEqual(first.files.map(file => file.path), ['first.md']);
  assert.equal(first.files[0].snippets[0].lines.find(line => line.ranges.length).number, 2);
  assert.deepEqual((await query('second.md')).files.map(file => file.path), ['second.md']);
  await assert.rejects(query('second.md', { searchId: first.searchId }), /expired/i);
  await assert.rejects(query(''), /current file/i);
  await assert.rejects(query('../first.md'), /repository-relative/i);
});

test('scope selection restricts full-text results before pagination and facets; filenames alone never match', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'search-scopes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = [];
  for (let i = 0; i < 25; i++) {
    const path = `note-${String(i).padStart(2, '0')}.md`; paths.push(path);
    await writeFile(resolve(root, path), '# needle\n');
  }
  await writeFile(resolve(root, 'other.js'), 'const needle = 1;\n');
  await writeFile(resolve(root, 'needle-in-name.md'), 'No matching body text.\n');
  let members = paths;
  const search = createLibrarySearch(root, undefined, scope => scope === 'bookmarks' ? members : ['other.js']);
  const query = (scope, extra = {}) => search(new URLSearchParams({ q: 'needle', scope, ...extra }));
  const all = await query('files'); assert.equal(all.total, 26);
  const bookmarks = await query('bookmarks');
  assert.equal(bookmarks.total, 25); assert.equal(bookmarks.files.length, 20); assert.equal(bookmarks.nextOffset, 20);
  assert.ok(bookmarks.files.every(file => file.path.endsWith('.md')));
  assert.deepEqual(bookmarks.facets.languages, [{ value: 'Markdown', count: 25 }]);
  await assert.rejects(query('tabs'), /Choose one/);
  // Old pages retain the original membership, even when the user removes bookmarks.
  members = [paths[0]];
  const more = await query('bookmarks', { searchId: bookmarks.searchId, offset: '20' });
  assert.equal(more.total, 25); assert.equal(more.files.length, 5); assert.equal(more.nextOffset, null);
  const fresh = await query('bookmarks'); assert.equal(fresh.total, 1);
  await assert.rejects(query('files', { searchId: bookmarks.searchId }), /expired/i);
  await assert.rejects(search(new URLSearchParams('q=needle&scope=files&scope=tabs')), /Choose one/);
  await assert.rejects(query('files,tabs'), /Choose one/);
  members = []; assert.equal((await query('bookmarks')).total, 0);
});

test('scoped full-text search retains regex, language, path and repository isolation', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'scope-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = resolve(root, 'first'), second = resolve(root, 'second');
  await mkdir(first); await mkdir(second); await mkdir(resolve(first, 'docs'));
  await writeFile(resolve(first, 'docs', 'note.md'), '# NEEDLE\n');
  await writeFile(resolve(first, 'source.js'), 'const needle = 1;\n');
  await writeFile(resolve(second, 'separate.md'), '# needle\n');
  const dataDirectory = resolve(root, 'data');
  const repositories = await openRepositories(dataDirectory);
  const a = await repositories.add(first), b = await repositories.add(second);
  await repositories.setBookmark(a.id, 'docs/note.md', true);
  await repositories.setBookmark(b.id, 'separate.md', true);
  const app = createRepositoryRoutes({ repositories, defaultRepo: a, dataDirectory,
    json: (value, status = 200) => Response.json(value, { status }), checkedPath: (path, directory) => resolve(directory, path) });
  const search = async (repo, scope, q) => (await app.request(`/${repo}/api/search?${new URLSearchParams({ scope, q })}`)).json();
  assert.deepEqual((await search(a.slug, 'bookmarks', '/needle/i lang:md path:docs/')).files.map(file => file.path), ['docs/note.md']);
  assert.deepEqual((await search(b.slug, 'bookmarks', 'needle')).files.map(file => file.path), ['separate.md']);
  assert.equal((await app.request(`/${a.slug}/api/search?q=needle&scope=invalid`)).status, 400);
});

test('the Bookmarks sidebar ignores the Files query and leaves its original search state untouched', () => {
  const nodes = [
    { path: 'bookmarked.md', name: 'bookmarked.md', type: 'file' },
    { path: 'unrelated.md', name: 'unrelated.md', type: 'file' },
  ];
  const state = { query: 'unrelated', bookmarks: [{ path: 'bookmarked.md' }] };
  assert.deepEqual(fileTreeForView(nodes, { ...state, bookmarksOnly: true }).map(node => node.path), ['bookmarked.md']);
  assert.equal(state.query, 'unrelated');
  assert.deepEqual(fileTreeForView(nodes, state).map(node => node.path), ['unrelated.md']);
});
