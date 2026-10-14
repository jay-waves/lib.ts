import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createPdfService } from '../server/pdf/engine.mjs';
import { samplePdf, outlinedPdf } from './fixtures/pdf.mjs';

async function setup(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'pdf-worker-'));
  const file = resolve(directory, 'sample.pdf');
  await writeFile(file, samplePdf());
  const stages = [], state = { active: false };
  const service = createPdfService({ isActive: () => state.active, workerIdleMs: 25,
    profile: stage => stages.push(stage) });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, file, info: await stat(file), stages, state };
}

async function waitForStop(stages) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (stages.includes('MuPDF worker stop')) return;
    await delay(10);
  }
  assert.fail('PDF worker did not stop');
}

test('PDF worker starts on demand, transfers high-resolution pages, and restarts after idle', async t => {
  const { service, file, info, stages } = await setup(t);
  assert.deepEqual(stages, []);
  const [document, duplicate] = await Promise.all([service.document(file, info), service.document(file, info)]);
  assert.strictEqual(document, duplicate);
  assert.deepEqual(document.pages, [{ width: 595, height: 842 }]);
  assert.equal(document.pdf, undefined);
  const first = await service.page(file, 1);
  const data = Buffer.from(await first.arrayBuffer());
  assert.equal(first.headers.get('content-type'), 'image/webp');
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.width, 1800);
  assert.ok(metadata.height > 2500);
  await waitForStop(stages);
  assert.deepEqual(Buffer.from(await (await service.page(file, 1)).arrayBuffer()), data);
  assert.equal(stages.filter(stage => stage === 'MuPDF worker start').length, 1, 'cached pages do not restart WASM');
  const larger = await service.page(file, 1, 2250);
  const largeMetadata = await sharp(Buffer.from(await larger.arrayBuffer())).metadata();
  assert.equal(largeMetadata.width, 2250);
  assert.ok(largeMetadata.width * largeMetadata.height < 8_010_000);
  assert.equal(stages.filter(stage => stage === 'MuPDF worker start').length, 2);
  assert.equal((await service.page(file, 2)).status, 404);
});

test('PDF page requests share rendering and use separate resolution cache entries', async t => {
  const { service, file, stages, state } = await setup(t);
  state.active = true;
  const responses = await Promise.all(Array.from({ length: 8 }, () => service.page(file, 1)));
  for (const response of responses) assert.equal(response.status, 200);
  assert.equal(stages.filter(stage => stage === 'pdf page').length, 1);
  await service.page(file, 1, 1350);
  assert.equal(stages.filter(stage => stage === 'pdf page').length, 2);
  await service.page(file, 1);
  assert.equal(stages.filter(stage => stage === 'pdf page').length, 2);
});

test('active PDFs retain the worker and sweeps do not keep an idle worker alive', async t => {
  const { service, file, info, stages, state } = await setup(t);
  await service.document(file, info);
  state.active = true;
  await delay(80);
  assert.ok(!stages.includes('MuPDF worker stop'));
  state.active = false;
  for (let index = 0; index < 3; index++) { await service.sweep(); await delay(5); }
  await waitForStop(stages);
});

test('PDF revision changes reject old page URLs and close prevents new work', async t => {
  const { service, file, info, stages } = await setup(t);
  await service.document(file, info);
  await waitForStop(stages);
  await writeFile(file, samplePdf(600, 850));
  assert.equal((await service.page(file, 1, 1800, info.mtime.toISOString())).status, 410);
  const result = await service.document(file, await stat(file));
  assert.equal(result.pages[0].width, 600);
  await service.close();
  await assert.rejects(service.document(file, { mtimeMs: -1, size: 0 }), /closed/);
});

test('MuPDF preserves nested PDF outlines, Unicode titles, and rotated page geometry', async t => {
  const { service, file } = await setup(t);
  await writeFile(file, outlinedPdf());
  const document = await service.document(file, await stat(file));
  assert.deepEqual(document.outline, [
    { name: 'Chapter', level: 1, page: 1 },
    { name: String.fromCodePoint(0x4e2d, 0x6587), level: 2, page: 2 },
  ]);
  assert.deepEqual(document.pages, [{ width: 300, height: 200 }, { width: 400, height: 500 }]);
  const image = await service.page(file, 1, 450);
  const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  assert.equal(metadata.width, 450);
  assert.equal(metadata.height, 300);
});

test('high zoom respects the raster budget after rounding pixel dimensions', async t => {
  const { service, file } = await setup(t);
  const image = await service.page(file, 1, 3600);
  const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  assert.ok(metadata.width * metadata.height <= 8_000_000);
});

