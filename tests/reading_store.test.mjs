import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createReadingStore } from '../library/reading-store.mjs';
import { openRepositories } from '../library/repositories.mjs';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';

test('reading batches survive restart, merge concurrent updates and isolate repos', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'reading-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createReadingStore(directory);
  await Promise.all([store.save('a', { 'note.md': { line: 5 } }), store.save('a', { 'note.md': { scale: 2 }, 'other.md': { view: 'raw' } })]);
  await store.flush();
  assert.deepEqual(await createReadingStore(directory).read('a'), { 'note.md': { line: 5, scale: 2 }, 'other.md': { view: 'raw' } });
  assert.deepEqual(await store.read('b'), {});
  assert.throws(() => store.save('a', { '../bad': {} }));
});

test('reading routes accept one batch, persist and reject cross-origin writes', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'reading-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDirectory = resolve(directory, 'data');
  const repositories = await openRepositories(dataDirectory);
  const defaultRepo = await repositories.add(directory);
  const app = createRepositoryRoutes({ repositories, defaultRepo, dataDirectory, dist: directory,
    json: (body, status = 200) => Response.json(body, { status }), checkedPath: path => path });
  const body = JSON.stringify({ positions: { 'note.md': { line: 42 } } });
  assert.equal((await app.request(`/${defaultRepo.id}/api/reading`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).status, 200);
  assert.deepEqual(await (await app.request(`/${defaultRepo.id}/api/reading`)).json(), { 'note.md': { line: 42 } });
  assert.equal((await app.request(`/${defaultRepo.id}/api/reading`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body })).status, 403);
  await app.closeReadingState();
});
