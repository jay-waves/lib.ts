import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { watchLibraryTree } from '../library/tree-watch.mjs';
import { createLibraryRoutes } from '../library/routes.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
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
