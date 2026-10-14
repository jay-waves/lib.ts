import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { createTypstService } from '../server/typst/service.mjs';
import { createArtifactStore } from '../server/typst/artifacts.mjs';

function setup(t, options = {}) {
  const calls = [], gates = new Map(), artifacts = new Set();
  const store = createArtifactStore({ maxBytes: options.artifactMaxBytes, maxEntries: options.artifactLimit });
  const sync = () => { artifacts.clear(); for (const id of store.keys()) artifacts.add(id); };
  const worker = { running: true, stop: async () => { worker.running = false; },
    async request(method, args) {
      calls.push({ method, args });
      if (method === 'compile') {
        const gate = gates.get(args.source);
        if (gate) await gate.promise;
        const result = { info: [{ width: 100, height: 100 }, { width: 100, height: 100 }],
          artifactBytes: args.source === 'oversized' ? 100 : 10, revisions: [], diagnostics: [] };
        store.set(args.id, result); sync();
        return result;
      }
      if (method === 'discard') { store.delete(args); sync(); }
      if (method === 'page') {
        if (!store.get(args.id)) throw Object.assign(new Error('missing artifact'), { code: 'ARTIFACT_MISSING' });
        return { svg: `<svg>${args.page}</svg>`, links: [] };
      }
      if (method === 'retain') { await gates.get('retain')?.promise; store.retain(args); sync(); }
    } };
  const service = createTypstService({ root: process.cwd(),
    emit() {}, isActive: () => true, workerFactory: () => worker, ...options });
  t.after(() => service.close());
  const gate = source => {
    let release;
    const promise = new Promise(done => { release = done; });
    gates.set(source, { promise });
    return release;
  };
  const compile = (source, revision, options) => service.compile(resolve('note.typ'), source, revision, options);
  return { service, calls, artifacts, gate, compile };
}

test('rapid edits compile only running and newest versions; obsolete artifacts are discarded', async t => {
  const { calls, artifacts, gate, compile } = setup(t);
  const release = gate('first');
  const first = compile('first', 1);
  const rejectedFirst = assert.rejects(first, { code: 'SUPERSEDED' });
  await tick();
  const intermediate = compile('intermediate', 2);
  const rejectedIntermediate = assert.rejects(intermediate, { code: 'SUPERSEDED' });
  const latest = compile('latest', 3);
  await tick(); await rejectedIntermediate;
  release(); await rejectedFirst;
  const item = await latest;
  assert.deepEqual(calls.filter(call => call.method === 'compile').map(call => call.args.source), ['first', 'latest']);
  assert.deepEqual([...artifacts], [item.id]);
  assert.strictEqual(await compile('latest', 3), item);
});

test('theme variants remain independent and one subscriber cannot cancel another', async t => {
  const { compile, gate, calls } = setup(t);
  const release = gate('same');
  const a = new AbortController(), b = new AbortController();
  const first = compile('same', 1, { theme: 'light', signal: a.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = compile('same', 1, { theme: 'light', signal: b.signal });
  const dark = compile('same', 1, { theme: 'dark' });
  await tick(); a.abort(); await rejected;
  release();
  assert.notEqual((await second).id, (await dark).id);
  assert.equal(calls.filter(call => call.method === 'compile').length, 2);
});

test('navigation cancels queued work and discards already running results', async t => {
  const { compile, gate, calls, artifacts } = setup(t);
  const release = gate('running');
  const a = new AbortController(), b = new AbortController();
  const running = compile('running', 1, { signal: a.signal });
  const rejectedRunning = assert.rejects(running, { name: 'AbortError' });
  await tick();
  const queued = compile('queued', 2, { theme: 'dark', signal: b.signal });
  const rejectedQueued = assert.rejects(queued, { name: 'AbortError' });
  await tick(); b.abort(); a.abort();
  await Promise.all([rejectedRunning, rejectedQueued]);
  release(); await tick();
  assert.deepEqual(calls.filter(call => call.method === 'compile').map(call => call.args.source), ['running']);
  assert.equal(artifacts.size, 0);
});

test('visible pages overtake queued prefetch without dynamic promotion', async t => {
  const { service, compile, gate, calls } = setup(t);
  const item = await compile('ready', 1);
  const release = gate('blocker');
  const blocker = compile('blocker', 2);
  await tick();
  const background = service.page(item.id, 1, { prefetch: true });
  const visible = service.page(item.id, 2);
  release(); await Promise.all([blocker, background, visible]);
  assert.deepEqual(calls.filter(call => call.method === 'page').map(call => call.args.page), [2, 1]);
});

test('history eviction immediately releases worker artifacts and invalidates old page IDs', async t => {
  const { service, compile, artifacts } = setup(t);
  const first = await compile('first', 1);
  const second = await compile('second', 2);
  const third = await compile('third', 3);
  await tick();
  assert.deepEqual([...artifacts], [second.id, third.id]);
  assert.equal(service.file(first.id), undefined);
  await assert.rejects(service.page(first.id, 1), { status: 410 });
  assert.match((await service.page(second.id, 1)).svg, /<svg/);
});

test('byte pressure releases previous artifacts and oversized pages do not trigger compile loops', async t => {
  const { service, compile, artifacts, calls } = setup(t, { artifactMaxBytes: 15 });
  const first = await compile('first', 1);
  const second = await compile('second', 2);
  assert.deepEqual([...artifacts], [second.id]);
  assert.equal(service.file(first.id), first.file, 'artifact eviction preserves the document identity');
  const oversized = await compile('oversized', 3);
  assert.deepEqual([...artifacts], [oversized.id]);
  assert.match((await service.page(oversized.id, 1)).svg, /<svg/);
  assert.match((await service.page(oversized.id, 2)).svg, /<svg/);
  assert.equal(service.file(oversized.id), oversized.file);
  assert.equal(calls.filter(call => call.method === 'compile').length, 3);
});

test('artifact eviction preserves metadata and cached pages across more than three active documents', async t => {
  const { service, artifacts, calls } = setup(t);
  const items = [];
  for (let index = 0; index < 6; index++) {
    const item = await service.compile(resolve(`${index}.typ`), String(index), 1);
    item.revisions = []; // Fake worker: isolate residency from real filesystem validation.
    items.push(item);
    await service.page(item.id, 1);
  }
  assert.equal(artifacts.size, 3);
  for (const item of items) assert.equal(service.file(item.id), item.file);
  const before = calls.length;
  assert.match((await service.page(items[0].id, 1)).svg, /<svg/);
  assert.equal(calls.length, before, 'an encoded page survives artifact eviction');
  assert.match((await service.page(items[0].id, 2)).svg, /<svg/);
  assert.equal(artifacts.size, 3);
  assert.equal(calls.filter(call => call.method === 'compile').length, 7);
  assert.equal(service.file(items[0].id), items[0].file);
});

test('a second expiration during retention is flushed before maintenance completes', async t => {
  const { service, compile, artifacts, gate } = setup(t, { isActive: () => false });
  const first = await compile('first', 1, { theme: 'light' });
  const second = await compile('second', 1, { theme: 'dark' });
  first.lastUsed = 0; second.lastUsed = 500000;
  const release = gate('retain');
  service.sweep(900001);
  await tick();
  service.sweep(1400001);
  release(); await tick();
  assert.equal(service.file(first.id), undefined);
  assert.equal(service.file(second.id), undefined);
  assert.equal(artifacts.size, 0);
});
