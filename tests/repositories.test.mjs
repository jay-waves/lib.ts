import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openRepositories } from '../library/repositories.mjs';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';
import { createSearchCache } from '../library/search-cache.mjs';

test('empty registry serves the library and permits explicit registration without a default repo', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-empty-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, 'notes');
  await mkdir(root);
  await writeFile(resolve(root, 'note.md'), 'hello');
  await writeFile(resolve(temporary, 'index.html'), 'library');
  const repositories = await openRepositories(resolve(temporary, 'data'));
  const app = createRepositoryRoutes({ repositories, initialRoot: root, dist: temporary,
    json: (body, status = 200) => Response.json(body, { status }),
    checkedPath: (path, root) => resolve(root, path), renderMarkdown: text => text });
  assert.deepEqual(await (await app.request('/api/repos')).json(), { repos: [], defaultRepoId: null });
  assert.equal(await (await app.request('/')).text(), 'library');
  assert.equal((await app.request('/api/bookmarks')).status, 404);
  assert.equal((await app.request('/api/search-repos?q=hello')).status, 404);
  assert.equal((await (await app.request('/api/directories')).json()).path, await realpath(root));
  assert.deepEqual(repositories.list(), []);
  const response = await app.request('/api/repos', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root }) });
  assert.equal(response.status, 201);
  const repo = await response.json();
  assert.equal((await (await app.request(`${repo.apiUrl}/document?path=note.md`)).json()).source, 'hello');
  assert.equal((await openRepositories(resolve(temporary, 'data'))).list().length, 1);
});

test('folder URLs encode names, preserve identities and reject duplicate folder names', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-names-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const folder = '中文 notes #%';
  const first = resolve(temporary, 'one', folder), second = resolve(temporary, 'two', folder);
  await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
  await writeFile(resolve(first, 'note.md'), 'hello');
  const data = resolve(temporary, 'data');
  await mkdir(data);
  await writeFile(resolve(data, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'existing-id', name: 'Custom display name', root: await realpath(first), bookmarks: [{ path: 'note.md' }] },
  ] }));
  const store = await openRepositories(data);
  const a = store.get('existing-id');
  assert.equal(a.slug, folder);
  assert.equal((await store.add(first)).id, a.id);
  await assert.rejects(store.add(second, 'Different name'), /folder name already registered/);
  assert.equal(store.list().length, 1);
  assert.deepEqual((await openRepositories(data)).bookmarks(a.id), [{ path: 'note.md' }]);
  const app = createRepositoryRoutes({ repositories: store, defaultRepo: a, dist: temporary,
    json: (body, status = 200) => Response.json(body, { status }),
    checkedPath: (path, root) => resolve(root, path), renderMarkdown: text => text });
  const encoded = encodeURIComponent(folder), api = `/${encoded}/api`;
  const metadata = await (await app.request(api)).json();
  assert.equal(metadata.url, `/${encoded}/tree/`);
  assert.equal(metadata.apiUrl, api);
  assert.equal((await (await app.request(`${api}/document?path=note.md`)).json()).source, 'hello');
  assert.equal((await (await app.request(`${api}/bookmarks`)).json()).bookmarks.length, 1);
  const used = await app.request(`${api}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(used.status, 200);
  await writeFile(resolve(temporary, 'index.html'), 'library');
  assert.equal(await (await app.request(`/${encoded}/tree/note.md`)).text(), 'library');
  assert.equal(await (await app.request(`/${encoded}/search?q=hello`)).text(), 'library');
  assert.equal(await (await app.request(`/${encoded}/git?path=note.md&scope=staged`)).text(), 'library');
  const specialPath = 'docs/中文 notes #%?.typ';
  assert.equal(await (await app.request(`/${encoded}/tree/${specialPath.split('/').map(encodeURIComponent).join('/')}?view=raw&line=12`)).text(), 'library');
  assert.equal((await app.request(`/${encoded}/tree`)).headers.get('location'), `/${encoded}/tree/`);
  assert.equal((await app.request('/notes/note.md')).status, 404);
  assert.equal((await app.request(`/repos/${encoded}/notes/note.md`)).status, 404);
  assert.equal((await app.request(`/tree/${encoded}/note.md`)).status, 404);
  const rejected = await app.request('/api/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: second }) });
  assert.equal(rejected.status, 400);
  // Existing conflicting registrations fail migration without rewriting their data.
  const conflicting = JSON.stringify({ version: 1, repos: [a, { ...a, id: 'another-id', root: second }] });
  await writeFile(resolve(data, 'repos.json'), conflicting);
  await assert.rejects(openRepositories(data), /folder name already registered/);
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(resolve(data, 'repos.json'), 'utf8'), conflicting);
});

test('repo registry persists stable identities and serializes concurrent registration', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-registry-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = resolve(temporary, 'first'), second = resolve(temporary, 'second');
  await mkdir(first); await mkdir(second);
  const store = await openRepositories(resolve(temporary, 'data'));
  const [a, duplicate, b] = await Promise.all([store.add(first), store.add(first), store.add(second, 'Notes')]);
  assert.equal(a.id, duplicate.id);
  assert.notEqual(a.id, b.id);
  const reopened = await openRepositories(resolve(temporary, 'data'));
  assert.deepEqual(reopened.list(), store.list());
  await assert.rejects(store.add(resolve(temporary, 'missing')));
  await writeFile(resolve(first, 'file.md'), '# First');
  await assert.rejects(store.add(resolve(first, 'file.md')), /directory/);
});

test('global route names cannot be registered as repositories', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-reserved-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const store = await openRepositories(resolve(temporary, 'data'));
  for (const name of ['api', 'assets']) {
    const directory = resolve(temporary, name);
    await mkdir(directory);
    await assert.rejects(store.add(directory), /reserved/);
  }
});

test('repo URLs isolate documents, assets and search', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-routes-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = resolve(temporary, 'first'), second = resolve(temporary, 'second');
  await mkdir(first); await mkdir(second);
  await writeFile(resolve(first, 'note.md'), 'firstmarker');
  await writeFile(resolve(second, 'note.md'), 'secondmarker');
  // File kinds are detected from content, so the asset fixture must be a real image.
  await writeFile(resolve(second, 'image.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=', 'base64'));
  const store = await openRepositories(resolve(temporary, 'data'));
  const a = await store.add(first), b = await store.add(second);
  const { realpathSync } = await import('node:fs');
  const { relative, isAbsolute } = await import('node:path');
  const app = createRepositoryRoutes({ repositories: store, defaultRepo: a, dist: temporary,
    json: (body, status = 200) => Response.json(body, { status }),
    checkedPath(value, root) {
      const file = realpathSync(resolve(root, value));
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Outside repo');
      return file;
    }, renderMarkdown: text => text });
  const get = path => app.request(path);
  const prefix = `/${encodeURIComponent(b.slug)}/api`;
  for (const path of [`/${a.slug}/api/git/status`, `${prefix}/git/status`]) {
    const response = await get(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).repository, false);
  }
  assert.equal((await (await get(`/${a.slug}/api/document?path=note.md`)).json()).source, 'firstmarker');
  assert.equal((await (await get(`${prefix}/document?path=note.md`)).json()).source, 'secondmarker');
  assert.equal((await (await get(`${prefix}/document?path=image.png`)).json()).url, `${prefix}/asset?path=image.png`);
  assert.equal((await get(`${prefix}/document?path=../first/note.md`)).status, 400);
  assert.equal((await get('/missing/api/tree')).status, 404);
  assert.equal((await get(`${prefix}/asset?path=note.md`)).status, 200);
  assert.equal((await (await get(`${prefix}/search?q=secondmarker`)).json()).total, 1);
  assert.equal((await (await get(`/${a.id}/api/search?q=secondmarker`)).json()).total, 0);
  await writeFile(resolve(temporary, 'index.html'), 'library');
  assert.equal((await get(`/${b.id}/tree/note.md`)).headers.get('location'), `/${encodeURIComponent(b.slug)}/tree/note.md`);
  assert.equal((await get(`/${b.id}/tree`)).status, 308);
  assert.equal((await get(`/repos/${b.id}/notes/note.md`)).status, 404);
  const registered = await app.request('/api/repos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: second }) });
  assert.equal((await registered.json()).id, b.id);
  assert.equal((await get('/api/repos')).status, 200);
});

test('recent use is persisted and sorts repos above unused registrations', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-recents-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(resolve(temporary, 'a')); await mkdir(resolve(temporary, 'b'));
  const store = await openRepositories(resolve(temporary, 'data'));
  const a = await store.add(resolve(temporary, 'a'));
  const b = await store.add(resolve(temporary, 'b'));
  const used = await store.touch(a.id);
  assert.ok(used.lastUsedAt);
  assert.equal(store.list()[0].id, a.id);
  const reopened = await openRepositories(resolve(temporary, 'data'));
  assert.equal(reopened.list()[0].id, a.id);
  assert.equal(reopened.get(a.id).lastUsedAt, used.lastUsedAt);
  assert.equal(reopened.get(b.id).lastUsedAt, undefined);
  assert.equal(await reopened.touch('missing'), null);
});

test('directory browser exposes folders, parent navigation and protects application data', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-directories-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(resolve(temporary, 'Notes'));
  await mkdir(resolve(temporary, '.hidden'));
  await mkdir(resolve(temporary, 'node_modules'));
  await writeFile(resolve(temporary, 'file.md'), 'text');
  const dataDirectory = resolve(temporary, 'data');
  const store = await openRepositories(dataDirectory);
  const defaultRepo = await store.add(temporary);
  const app = createRepositoryRoutes({ repositories: store, defaultRepo, dataDirectory,
    json: (value, status = 200) => Response.json(value, { status }), checkedPath: value => value });
  const listing = await (await app.request('/api/directories')).json();
  assert.deepEqual(listing.directories.map(item => item.name), ['Notes']);
  assert.ok(listing.parent);
  assert.ok(listing.drives.length);
  const child = await (await app.request(`/api/directories?path=${encodeURIComponent(listing.directories[0].path)}`)).json();
  assert.equal(child.parent, listing.path);
  assert.equal((await app.request(`/api/directories?path=${encodeURIComponent(dataDirectory)}`)).status, 400);
  assert.equal((await app.request(`/api/directories?path=${encodeURIComponent(resolve(temporary, 'missing'))}`)).status, 404);
  const use = await app.request(`/${defaultRepo.id}/api/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.ok((await use.json()).lastUsedAt);
  const blocked = await app.request('/api/repos', { method: 'POST', headers: { origin: 'https://external.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(blocked.status, 403);
});

test('repository search defaults locally, supports all repos, prioritizes the current file and keeps stable pages', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-search-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = resolve(temporary, 'first'), second = resolve(temporary, 'second');
  await mkdir(first); await mkdir(second);
  for (let index = 0; index < 23; index++) await writeFile(resolve(first, `${index}.js`), 'needle NEEDLE');
  await writeFile(resolve(first, 'z.md'), 'needle');
  await writeFile(resolve(second, 'z.md'), 'needle');
  const store = await openRepositories(resolve(temporary, 'data'));
  const a = await store.add(first), b = await store.add(second);
  const app = createRepositoryRoutes({ repositories: store, defaultRepo: a,
    json: (body, status = 200) => Response.json(body, { status }), checkedPath: value => value });
  const params = new URLSearchParams({ q: 'needle', currentRepo: a.id, currentFile: 'z.md' });
  const get = async () => {
    const response = await app.request(`/api/search-repos?${params}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const local = await get();
  assert.equal(local.total, 24);
  assert.equal(local.files[0].path, 'z.md');
  assert.ok(local.files.every(file => file.repoId === a.id));
  params.set('repo', '*');
  const all = await get();
  assert.equal(all.total, 25);
  assert.equal(all.files[0].repoId, a.id);
  assert.equal(all.files[0].path, 'z.md');
  await writeFile(resolve(second, 'new.md'), 'needle');
  params.set('searchId', all.searchId); params.set('offset', '20');
  const page = await get();
  assert.equal(page.total, 25);
  assert.equal(page.nextOffset, null);
  assert.equal(new Set([...all.files, ...page.files].map(file => `${file.repoId}:${file.path}`)).size, 25);
  params.delete('searchId'); params.delete('offset'); params.set('repo', b.id);
  assert.equal((await get()).total, 2);
  params.set('q', 'NEEDLE case:yes'); params.set('repo', a.id);
  assert.equal((await get()).matchCount, 23);
  params.set('q', '/NEEDLE/');
  assert.equal((await get()).matchCount, 23);
  params.set('q', '/NEEDLE/i'); params.set('repo', '*');
  assert.equal((await get()).matchCount, 49);
});

test('aggregated repository snapshots expire under the shared memory budget and can be searched again', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'repo-snapshot-budget-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, 'notes');
  await mkdir(root);
  await writeFile(resolve(root, 'note.md'), 'needle');
  const repositories = await openRepositories(resolve(temporary, 'data'));
  const defaultRepo = await repositories.add(root);
  const app = createRepositoryRoutes({ repositories, defaultRepo,
    json: (value, status = 200) => Response.json(value, { status }), checkedPath: value => value });
  const first = await (await app.request('/api/search-repos?q=needle')).json();
  assert.equal(first.total, 1);
  const pressure = createSearchCache();
  t.after(() => pressure.delete('budget-pressure'));
  pressure.set('budget-pressure', { resultBytes: 8 * 1024 * 1024 });
  const expired = await app.request(`/api/search-repos?q=needle&searchId=${first.searchId}`);
  assert.equal(expired.status, 400);
  assert.match((await expired.json()).error, /expired/i);
  const refreshed = await (await app.request('/api/search-repos?q=needle')).json();
  assert.equal(refreshed.total, 1);
  assert.notEqual(refreshed.searchId, first.searchId);
});
