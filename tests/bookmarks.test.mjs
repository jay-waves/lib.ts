import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { openRepositories } from '../library/repositories.mjs';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'bookmarks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = resolve(root, 'data');
  const aRoot = resolve(root, 'a'), bRoot = resolve(root, 'b');
  await mkdir(aRoot); await mkdir(bRoot);
  await writeFile(resolve(aRoot, 'note.md'), 'A');
  await mkdir(resolve(aRoot, 'folder'));
  await writeFile(resolve(bRoot, 'note.md'), 'B');
  const store = await openRepositories(data);
  const a = await store.add(aRoot), b = await store.add(bRoot);
  const app = createRepositoryRoutes({ repositories: store, defaultRepo: a,
    json: (body, status = 200) => Response.json(body, { status }),
    checkedPath(path, repoRoot) {
      const file = realpathSync(resolve(repoRoot, path));
      const rel = relative(repoRoot, file);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Outside repo');
      return file;
    } });
  const put = (url, path, bookmarked, headers = {}) => app.request(url, { method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ path, bookmarked }) });
  return { root, data, store, a, b, app, put, aRoot };
}

test('bookmarks persist, stay repo-scoped and repeated adds do not duplicate files', async t => {
  const { data, store, a, b, app, put } = await fixture(t);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', true)).status, 200);
  assert.equal((await put(`/${b.id}/api/bookmarks`, 'note.md', true)).status, 200);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', true)).status, 200);
  assert.equal(store.bookmarks(a.id).length, 1);
  assert.equal(store.bookmarks(b.id).length, 1);
  assert.equal(Object.hasOwn(store.bookmarks(a.id)[0], 'tag'), false);
  const reopened = await openRepositories(data);
  assert.deepEqual(reopened.bookmarks(a.id), store.bookmarks(a.id));
  assert.deepEqual(reopened.bookmarks(b.id), store.bookmarks(b.id));
  const body = await (await app.request(`/${a.id}/api/bookmarks`)).json();
  assert.equal(Object.hasOwn(body, 'tags'), false);
  assert.equal(body.bookmarks[0].path, 'note.md');
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', false)).status, 200);
  assert.equal(store.bookmarks(a.id).length, 0);
  assert.equal(store.bookmarks(b.id).length, 1);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', false)).status, 200);
});

test('bookmark writes validate the boolean state, repo-relative files and request origin', async t => {
  const { app, put, a } = await fixture(t);
  for (const [path, bookmarked] of [['note.md', 'todo'], ['../b/note.md', true], ['/note.md', true], ['C:/note.md', true], ['.', true], ['note.md', undefined], ['note.md', null]])
    assert.equal((await put(`/${a.id}/api/bookmarks`, path, bookmarked)).status, 400);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'missing.md', true)).status, 404);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'folder', true)).status, 400);
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', true, { origin: 'https://other.example' })).status, 403);
  assert.equal((await app.request(`/${a.id}/api/bookmarks`, { method: 'PUT', body: '{}' })).status, 415);
  assert.equal((await app.request('/missing/api/bookmarks')).status, 404);
  assert.equal((await put('/missing/api/bookmarks', 'note.md', true)).status, 404);
  assert.equal((await (await app.request(`/${a.id}/api/bookmarks`)).json()).bookmarks.length, 0);
});

test('concurrent bookmarks are preserved by other repo mutations', async t => {
  const { store, a, b } = await fixture(t);
  await Promise.all([store.setBookmark(a.id, 'one.md', true), store.setBookmark(a.id, 'two.md', true), store.touch(a.id)]);
  assert.equal(store.bookmarks(a.id).length, 2);
  await store.add(b.root);
  assert.equal(store.bookmarks(a.id).length, 2);
  const items = store.bookmarks(a.id);
  items[0].path = 'changed.md';
  assert.equal(store.bookmarks(a.id)[0].path, 'one.md');
});

test('bookmarks for deleted files can still be removed', async t => {
  const { put, store, a, aRoot } = await fixture(t);
  await put(`/${a.id}/api/bookmarks`, 'note.md', true);
  await rm(resolve(aRoot, 'note.md'));
  assert.equal((await put(`/${a.id}/api/bookmarks`, 'note.md', false)).status, 200);
  assert.deepEqual(store.bookmarks(a.id), []);
});
