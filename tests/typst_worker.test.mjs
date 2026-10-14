import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTypstService } from '../server/typst/service.mjs';
import { createTypstWorker } from '../server/typst/worker-client.mjs';

async function setup(t, { active = false, ...options } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'typst-worker-'));
  const file = resolve(root, 'note.typ');
  const source = `= First

Hello 世界
#pagebreak()
= Second

Another page`;
  await writeFile(file, source);
  const stages = [];
  const state = { active };
  const service = createTypstService({ root,
    emit() {}, profile: stage => stages.push(stage), isActive: () => state.active, workerIdleMs: 25, ...options });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { service, file, source, stages, state, modified: (await stat(file)).mtimeMs };
}

test('worker starts on demand, serializes compiles, and preserves page identity after idle restart', async t => {
  const { service, file, source, modified, stages } = await setup(t);
  assert.deepEqual(stages, []);
  const [item, duplicate] = await Promise.all([service.compile(file, source, modified), service.compile(file, source, modified)]);
  assert.strictEqual(item, duplicate);
  assert.equal(item.info.length, 2);
  assert.equal('artifact' in item, false);
  assert.ok(item.artifactBytes > 0, 'the worker reports actual vector buffer bytes without transferring the artifact');
  const firstImage = await service.page(item.id, 1);
  assert.match(firstImage.svg, /<svg/);
  await delay(100);
  // A cached page can be served without starting WASM again.
  assert.deepEqual(await service.page(item.id, 1), firstImage);
  assert.match((await service.page(item.id, 2)).svg, /<svg/);
  assert.equal(stages.filter(stage => stage === 'library compile/vector').length, 2);
  assert.equal(service.file(item.id), file);
});

test('active documents retain their worker, including when activity begins during the idle grace period', async t => {
  const { service, file, source, modified, state, stages } = await setup(t);
  const item = await service.compile(file, source, modified);
  state.active = true;
  await delay(100);
  assert.match((await service.page(item.id, 2)).svg, /<svg/);
  assert.equal(stages.filter(stage => stage === 'library compile/vector').length, 1);
  state.active = false;
  service.sweep();
  await delay(100);
  assert.match((await service.page(item.id, 1)).svg, /<svg/);
  assert.equal(stages.filter(stage => stage === 'library compile/vector').length, 2);
});

test('idle restart rejects a changed source rather than rendering it under old metadata', async t => {
  const { service, file, source, modified } = await setup(t);
  const item = await service.compile(file, source, modified);
  await delay(100);
  await writeFile(file, `#pagebreak()
Changed`);
  await assert.rejects(service.page(item.id, 1), { status: 410 });
});

test('idle restart rejects changed imports', async t => {
  const { service, file, modified } = await setup(t);
  const dependency = resolve(file, '../dependency.typ');
  await writeFile(dependency, '#let title = "First"');
  const source = `#import "dependency.typ": title
= #title`;
  await service.compile(file, source, modified);
  const item = await service.compile(file, source, modified, { theme: 'dark' });
  assert.deepEqual(item.diagnostics, []);
  assert.match(item.fingerprint, /^[a-f0-9]{64}$/);
  await delay(100);
  await writeFile(dependency, '#let title = "Second"');
  await assert.rejects(service.page(item.id, 1), { status: 410 });
});

test('worker can restart after termination and service close rejects new work', async t => {
  const worker = createTypstWorker({ root: process.cwd(), emit() {}, profile() {}, onStop() {} });
  t.after(() => worker.stop());
  assert.equal(worker.running, false);
  await worker.request('retain', []);
  assert.equal(worker.running, true);
  await worker.stop();
  assert.equal(worker.running, false);
  await worker.request('retain', []);
  assert.equal(worker.running, true);
  const { service, file, source, modified } = await setup(t);
  await service.close();
  await assert.rejects(service.compile(file, source, modified), /closed/);
});

test('worker artifact pressure restores pages under the same document ID', async t => {
  const { service, file, source, modified, stages } = await setup(t, { active: true, artifactLimit: 1 });
  const light = await service.compile(file, source, modified, { theme: 'light' });
  const lightImage = await service.page(light.id, 1);
  await service.compile(file, source, modified, { theme: 'dark' });
  assert.equal(service.file(light.id), file);
  assert.deepEqual(await service.page(light.id, 1), lightImage);
  assert.equal(stages.filter(stage => stage === 'library compile/vector').length, 2);
  assert.match((await service.page(light.id, 2)).svg, /<svg/);
  assert.equal(stages.filter(stage => stage === 'library compile/vector').length, 3);
  assert.equal(service.file(light.id), file);
});

test('native process recycling preserves cached pages and restores uncached pages under the same ID', async t => {
  const { service, file, source, modified, stages } = await setup(t, { active: true, maxCompilations: 2 });
  const original = await service.compile(file, source, modified);
  const image = await service.page(original.id, 1);
  await service.compile(file, source, modified, { theme: 'dark' });
  await service.compile(file, source + '\nUpdated', modified + 1);
  assert.equal(stages.filter(stage => stage === 'Typst worker start').length, 2);
  assert.deepEqual(await service.page(original.id, 1), image);
  assert.match((await service.page(original.id, 2)).svg, /<svg/);
  assert.equal(service.file(original.id), file);
});
