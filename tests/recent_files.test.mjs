import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createReadingStore } from '../library/reading-store.mjs';
import { createRecentFilesClient } from '../library/recent-files.mjs';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';
import { openRepositories } from '../library/repositories.mjs';

test('recent paths deduplicate, evict oldest at 100 and persist with reading positions', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'recent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createReadingStore(directory);
  await Promise.all(Array.from({ length: 105 }, (_, i) => store.visit('a', `math/${i}.md`)));
  let items = await store.recent('a');
  assert.equal(items.length, 100); assert.equal(items[0], 'math/104.md'); assert.equal(items.at(-1), 'math/5.md');
  await Promise.all([store.visit('a', 'math/25.md'), store.save('a', { 'math/25.md': { line: 42 } })]);
  await store.flush();
  const reopened = createReadingStore(directory);
  items = await reopened.recent('a');
  assert.equal(items[0], 'math/25.md'); assert.equal(items.length, 100); assert.equal(new Set(items).size, 100);
  assert.deepEqual(await reopened.read('a'), { 'math/25.md': { line: 42 } });
  assert.deepEqual(await reopened.recent('b'), []);
  const bytes = await readFile(resolve(directory, 'reading/a.json'), 'utf8');
  assert.ok(bytes.endsWith('\n')); assert.ok(!bytes.includes('\r'));
  assert.ok(JSON.parse(bytes).files.every(record => typeof record.path === 'string'));
  await Promise.all([store.clearRecent('a'), store.save('a', { 'math/25.md': { scale: 2 } })]);
  assert.deepEqual(await store.recent('a'), []);
  assert.deepEqual(await store.read('a'), { 'math/25.md': { line: 42, scale: 2 } });
  await store.close();
  assert.throws(() => store.visit('a', '../bad')); assert.throws(() => store.visit('../bad', 'note.md'));
});

test('existing reading data gains a recent list without changing stored positions', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'recent-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'reading'));
  await writeFile(resolve(directory, 'reading/a.json'), JSON.stringify({ positions: { 'note.md': { view: 'raw', line: 10 } } }));
  const store = createReadingStore(directory);
  assert.deepEqual(await store.recent('a'), []);
  await store.visit('a', 'note.md');
  assert.deepEqual(await store.read('a'), { 'note.md': { view: 'raw', line: 10 } });
  await store.close();
});

test('recent routes isolate repositories, validate real files and protect clearing', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'recent-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = resolve(directory, 'repo'); await mkdir(root);
  await writeFile(resolve(root, 'note.md'), '# Note'); await mkdir(resolve(root, 'folder'));
  const dataDirectory = resolve(directory, 'data');
  const repositories = await openRepositories(dataDirectory), defaultRepo = await repositories.add(root);
  const other = await repositories.add(directory);
  const app = createRepositoryRoutes({ repositories, defaultRepo, dataDirectory,
    checkedPath: (path, root) => resolve(root, path), json: (value, status = 200) => Response.json(value, { status }) });
  const endpoint = `/${defaultRepo.slug}/api/recent-files`;
  const send = (method, body = {}, headers = {}, url = endpoint) => app.request(url, {
    method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await send('POST', { path: 'note.md' })).status, 200);
  const history = await (await app.request(endpoint)).json();
  assert.deepEqual(history.recent, ['note.md']);
  assert.ok(Number.isFinite(Date.parse(history.visitedAt['note.md'])));
  assert.deepEqual(await (await app.request(`/${other.id}/api/recent-files`)).json(), { recent: [], visitedAt: {} });
  for (const path of ['../outside.md', '/absolute.md', 'C:/note.md', 'folder'])
    assert.equal((await send('POST', { path })).status, 400);
  assert.equal((await send('POST', { path: 'missing.md' })).status, 404);
  assert.equal((await send('POST', { path: 'note.md' }, { origin: 'https://other.example' })).status, 403);
  assert.equal((await send('DELETE', {}, { origin: 'https://other.example' })).status, 403);
  assert.equal((await app.request(endpoint, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await app.request('/missing/api/recent-files')).status, 404);
  assert.equal((await send('DELETE')).status, 200);
  assert.deepEqual(await (await app.request(endpoint)).json(), { recent: [], visitedAt: {} });
  await app.closeReadingState();
});

test('shared client orders a pending load, visits and clear and recovers after a failed request', async () => {
  let finishLoad; const requests = [], updates = [];
  const client = createRecentFilesClient('/recent', async (_url, options) => {
    requests.push(options.method || 'GET');
    if (!options.method) return new Promise(resolve => { finishLoad = () => resolve(Response.json({ recent: ['old.md'] })); });
    if (options.method === 'DELETE') return Response.json({ recent: [] });
    const { path } = JSON.parse(options.body);
    if (path === 'bad.md') return Response.json({ error: 'Missing' }, { status: 404 });
    assert.equal(options.keepalive, true);
    return Response.json({ recent: [path, 'old.md'] });
  });
  const stop = client.subscribe(items => updates.push(items));
  const load = client.load(), visit = client.visit('new.md'), clear = client.clear();
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(requests, ['GET']); finishLoad();
  await Promise.all([load, visit, clear]);
  assert.deepEqual(requests, ['GET', 'POST', 'DELETE']);
  assert.deepEqual(updates, [[], ['old.md'], ['new.md', 'old.md'], []]);
  await assert.rejects(client.visit('bad.md'), /Missing/);
  assert.deepEqual(await client.visit('again.md'), ['again.md', 'old.md']);
  stop(); const count = updates.length; await client.clear(); assert.equal(updates.length, count);
});


test('last visit dates persist, update on revisits and expire alongside the 100-path limit', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'recent-dates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.parse('2026-01-01T00:00:00Z');
  const store = createReadingStore(directory, { now: () => now });
  await store.visit('repo', 'a.md'); now += 86400000; await store.visit('repo', 'b.md');
  now += 86400000; await store.visit('repo', 'a.md');
  await store.save('repo', { 'a.md': { line: 10 } });
  await store.flush();
  const state = await createReadingStore(directory).recentHistory('repo');
  assert.deepEqual(state.recent, ['a.md', 'b.md']);
  assert.deepEqual(state.visitedAt, { 'a.md': '2026-01-03T00:00:00.000Z', 'b.md': '2026-01-02T00:00:00.000Z' });
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.visit('repo', `file${i}.md`)));
  const bounded = await store.recentHistory('repo');
  assert.equal(Object.keys(bounded.visitedAt).length, 100); assert.ok(!Object.hasOwn(bounded.visitedAt, 'a.md'));
  await store.clearRecent('repo'); assert.deepEqual(await store.recentHistory('repo'), { recent: [], visitedAt: {} });
  await store.close();
});

test('undated history is discarded while reading positions remain intact', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'recent-date-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(resolve(directory, 'reading'));
  await writeFile(resolve(directory, 'reading/repo.json'), JSON.stringify({ recent: ['old.md', 'other.md'], positions: { 'old.md': { line: 4 } } }));
  const store = createReadingStore(directory, { now: () => Date.parse('2026-01-01T00:00:00Z') });
  assert.deepEqual(await store.recentHistory('repo'), { recent: [], visitedAt: {} });
  await store.visit('repo', 'old.md');
  assert.deepEqual(await store.recentHistory('repo'), { recent: ['old.md'], visitedAt: { 'old.md': '2026-01-01T00:00:00.000Z' } });
  assert.deepEqual(await store.read('repo'), { 'old.md': { line: 4 } });
  await store.close();
});
