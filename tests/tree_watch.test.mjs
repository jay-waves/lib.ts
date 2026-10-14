import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watchLibraryTree } from '../server/tree-watch.mjs';
import { createLibraryRoutes } from '../server/routes.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('missing repository roots return JSON 404 for tree scans and event streams', async t => {
  const base = await mkdtemp(join(tmpdir(), 'tree-missing-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'gone');
  const app = createLibraryRoutes({ root, json: (body, status = 200) => Response.json(body, { status }) });
  for (const path of ['/api/tree', '/api/library/tree-events']) {
    const response = await app.request(path);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /no longer exists/);
  }
  await mkdir(root);
  await writeFile(join(root, 'restored.md'), 'restored');
  const response = await app.request('/api/tree');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).children[0].name, 'restored.md');
});
async function waitFor(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await pause(20); }
  assert.fail('Timed out waiting for filesystem notification');
}

test('tree SSE announces connection and changes, and a fresh tree contains new files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tree-events-'));
  const app = createLibraryRoutes({ root, checkedPath: path => resolve(root, path), json: Response.json });
  const response = await app.request('/api/library/tree-events');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body.getReader();
  t.after(async () => { await reader.cancel(); await rm(root, { recursive: true, force: true }); });
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value), /event: connected/);
  await writeFile(join(root, 'new.md'), '# New');
  let timeout;
  try {
    const message = await Promise.race([reader.read(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Missing tree SSE event')), 3000);
    })]);
    assert.match(decoder.decode(message.value), /event: tree/);
  } finally { clearTimeout(timeout); }
  const tree = await (await app.request('/api/tree')).json();
  assert.deepEqual(tree.children.map(node => node.path), ['new.md']);
});

test('closing repository routes finishes tree and document streams and releases viewers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'route-close-'));
  await writeFile(join(root, 'note.md'), '# Note');
  const changes = [];
  const app = createLibraryRoutes({ root, checkedPath: path => resolve(root, path), json: Response.json,
    onViewerChange: (file, active) => changes.push(active) });
  const readers = [];
  t.after(async () => { app.close(); for (const reader of readers) await reader.cancel(); await rm(root, { recursive: true, force: true }); });
  for (const path of ['/api/library/tree-events', '/api/library/events?path=note.md']) {
    const reader = (await app.request(path)).body.getReader();
    readers.push(reader);
    assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  }
  app.close(); app.close();
  for (const reader of readers) assert.equal((await reader.read()).done, true);
  assert.deepEqual(changes, [true, false]);
});

test('tree watchers stay within their repository, share updates and release subscribers', async t => {
  const base = await mkdtemp(join(tmpdir(), 'tree-watch-'));
  const root = join(base, 'repo'), other = join(base, 'other'), data = join(root, 'data');
  await Promise.all([root, other, data, join(root, '.hidden'), join(root, 'node_modules')]
    .map(path => mkdir(path, { recursive: true })));
  const first = [], second = [];
  const stopFirst = watchLibraryTree(root, error => first.push(error), data);
  const stopSecond = watchLibraryTree(root, error => second.push(error), data);
  t.after(async () => { stopFirst(); stopSecond(); await rm(base, { recursive: true, force: true }); });
  await Promise.all([other, data, join(root, '.hidden'), join(root, 'node_modules')]
    .map(path => writeFile(join(path, 'ignored.md'), 'ignored')));
  await pause(250);
  assert.equal(first.length, 0);
  await mkdir(join(root, 'nested'));
  const file = join(root, 'nested', 'a.md');
  await writeFile(file, 'new');
  await waitFor(() => first.length > 0);
  assert.equal(first.length, second.length);
  let count = first.length;
  await writeFile(file, 'edited');
  await waitFor(() => first.length > count);
  count = first.length;
  const renamed = join(root, 'nested', 'b.md');
  await rename(file, renamed);
  await waitFor(() => first.length > count);
  stopFirst();
  count = first.length;
  const secondCount = second.length;
  await rm(renamed);
  await waitFor(() => second.length > secondCount);
  assert.equal(first.length, count);
  assert.ok(second.every(error => error === undefined));
  stopSecond();
  count = second.length;
  await writeFile(join(root, 'last.md'), 'closed');
  await pause(250);
  assert.equal(second.length, count);
});
