import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createReadingStore } from '../library/reading-store.mjs';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(resolve(tmpdir(), 'reading-cache-'));
  const store = createReadingStore(directory, options);
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('history and positions share one cached read and coalesce updates into a single scheduled write', async t => {
  let reads = 0, writes = 0, tick; const delays = [];
  const { store, directory } = await fixture(t, {
    io: { ...fs, readFile: (...args) => { reads++; return fs.readFile(...args); },
      writeFile: (...args) => { writes++; return fs.writeFile(...args); } },
    setTimer: (callback, delay) => { tick = callback; delays.push(delay); return 1; }, clearTimer() {},
  });
  await Promise.all([store.read('repo'), store.recentHistory('repo')]);
  await store.visit('repo', 'note.md');
  await Promise.all(Array.from({ length: 50 }, (_, line) => store.save('repo', { 'note.md': { line: line + 1 } })));
  assert.equal(reads, 1); assert.equal(writes, 0); assert.deepEqual(delays, [2000]);
  const view = await store.read('repo'); view['note.md'].line = 999;
  assert.equal((await store.read('repo'))['note.md'].line, 50);
  tick(); await store.flush();
  assert.equal(writes, 1); assert.equal(reads, 1);
  const saved = JSON.parse(await fs.readFile(resolve(directory, 'reading/repo.json'), 'utf8'));
  assert.equal(saved.files.length, 1); assert.equal(saved.files[0].path, 'note.md'); assert.equal(saved.files[0].position.line, 50);
  assert.ok(saved.files[0].lastVisitedAt); assert.ok(!Object.hasOwn(saved, 'positions')); assert.ok(!Object.hasOwn(saved, 'recent'));
  await store.save('repo', { 'note.md': { line: 50 } }); await store.flush(); assert.equal(writes, 1);
});

test('each repository keeps at most 100 unified records and delayed saves cannot resurrect evicted paths', async t => {
  const { store, directory } = await fixture(t);
  for (let index = 0; index < 105; index++) {
    await store.visit('a', `${index}.md`); await store.save('a', { [`${index}.md`]: { line: index + 1 } });
  }
  await store.visit('b', 'other.md'); await store.save('b', { 'other.md': { line: 9 } });
  await store.save('a', { '0.md': { line: 999 } });
  assert.equal(Object.keys(await store.read('a')).length, 100);
  assert.ok(!Object.hasOwn(await store.read('a'), '0.md'));
  assert.deepEqual(await store.recent('b'), ['other.md']);
  const before = await store.recentHistory('a');
  await store.save('a', { '5.md': { line: 55 } });
  assert.deepEqual(await store.recentHistory('a'), before);
  await store.close();
  const reopened = createReadingStore(directory);
  assert.equal(Object.keys(await reopened.read('a')).length, 100);
  assert.deepEqual(await reopened.recent('b'), ['other.md']); await reopened.close();
});

test('a position change during disk write remains dirty and is flushed next', async t => {
  let releaseWrite, announceStart, writes = 0;
  const started = new Promise(resolve => { announceStart = resolve; });
  const { store, directory } = await fixture(t, { io: { ...fs, writeFile: async (...args) => {
    if (++writes === 1) { announceStart(); await new Promise(resolve => { releaseWrite = resolve; }); }
    return fs.writeFile(...args);
  } } });
  await store.save('repo', { 'note.md': { line: 1 } });
  const first = store.flush(); await started;
  await store.save('repo', { 'note.md': { line: 2 } }); releaseWrite(); await first;
  assert.equal(JSON.parse(await fs.readFile(resolve(directory, 'reading/repo.json'), 'utf8')).files[0].position.line, 1);
  await store.flush(); assert.equal(writes, 2);
  assert.equal((await createReadingStore(directory).read('repo'))['note.md'].line, 2);
});

test('failed flush retains dirty data for retry and normal close flushes pending changes', async t => {
  let fail = true, writes = 0;
  const { store, directory } = await fixture(t, { io: { ...fs, writeFile: (...args) => {
    writes++; if (fail) return Promise.reject(new Error('Disk busy')); return fs.writeFile(...args);
  } } });
  await store.visit('repo', 'note.md'); await store.save('repo', { 'note.md': { line: 42 } });
  await assert.rejects(store.flush(), /Disk busy/);
  assert.equal((await store.read('repo'))['note.md'].line, 42);
  fail = false; await store.close(); assert.equal(writes, 2);
  const reopened = createReadingStore(directory);
  assert.equal((await reopened.read('repo'))['note.md'].line, 42); assert.deepEqual(await reopened.recent('repo'), ['note.md']);
  await assert.rejects(store.visit('repo', 'later.md'), /closed/);
  await reopened.close();
});

test('browser position buffer is bounded to 100 paths and syncs without changing history timestamps', async t => {
  const originalFetch = globalThis.fetch; const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'PUT') requests.push(JSON.parse(options.body));
    return Response.json(options?.method === 'PUT' ? { ok: true } : {});
  };
  const { loadPosition, savePosition, readPosition, readingKey, syncReadingPositions } = await import('../library/reading-state.mjs?bounded-buffer');
  await loadPosition(readingKey('repo', 'note.md'), '/api', 'note.md');
  for (let index = 0; index < 120; index++) savePosition(readingKey('repo', `${index}.md`), { line: index + 1 });
  assert.deepEqual(readPosition(readingKey('repo', '0.md')), {});
  await syncReadingPositions();
  assert.equal(Object.keys(requests[0].positions).length, 100);
  assert.equal(requests[0].positions['119.md'].line, 120);
  assert.ok(!Object.hasOwn(requests[0], 'visitedAt'));
});
