import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { samplePdf } from './fixtures/pdf.mjs';
import { createPdfStore } from '../server/pdf/store.mjs';

async function setup(t, openDocument) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-lifecycle-'));
  const file = join(directory, 'book.pdf');
  await writeFile(file, samplePdf(200, 300));
  const store = createPdfStore(openDocument);
  t.after(async () => {
    try { await store.sweep(() => false, Date.now() + 1_000_000, 0); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { store, file, info: await stat(file) };
}

async function fakeStore(t) {
  const opened = [], closed = [];
  const hooks = {
    render: async () => new Uint8Array([1]),
    close: async document => { closed.push(document); },
  };
  const result = await setup(t, async () => {
    const document = { pages: [{ width: 200, height: 300 }], outline: [],
      render: (...args) => hooks.render(...args), close: () => hooks.close(document) };
    opened.push(document);
    return document;
  });
  return { ...result, hooks, opened, closed };
}

test('MuPDF documents reopen on demand after idle cleanup', async t => {
  const { store, file, info } = await setup(t);
  assert.equal((await store.document(file, info)).pages.length, 1);
  assert.equal((await store.page(file, 1)).status, 200);
  await store.sweep(() => false, Date.now() + 60_000, 0);
  assert.equal((await store.page(file, 1)).status, 200);
});

test('an active PDF retains only its newest opened revision after the grace period', async t => {
  const { store, opened, closed, file, info } = await fakeStore(t);
  for (let revision = 0; revision < 5; revision++) await store.document(file, { ...info, mtimeMs: info.mtimeMs + revision });
  await store.sweep(() => true, Date.now() + 61_000);
  assert.equal(closed.length, 4);
  assert.ok(!closed.includes(opened.at(-1)));
  await store.sweep(() => false, Date.now() + 301_000);
  assert.equal(closed.length, 5);
  const metadata = await store.document(file, info);
  assert.equal(opened.length, 6);
  assert.equal(metadata.document, undefined, 'native resources stay in the worker');
});

test('retained PDFs survive the count target and close exactly once after repo exit', async t => {
  const { store, opened, closed, file, info } = await fakeStore(t);
  const retained = new Set();
  for (let index = 0; index < 6; index++) {
    const path = `${file}-${index}.pdf`;
    await store.document(path, info);
    retained.add(path);
  }
  await store.sweep(path => retained.has(path), Date.now() + 600_000);
  assert.equal(opened.length, 6); assert.equal(closed.length, 0);
  retained.clear();
  await store.sweep(path => retained.has(path), Date.now() + 600_000);
  await store.sweep(() => false, Date.now() + 600_000);
  assert.equal(closed.length, 6);
});

test('failed document cleanup remains retryable', async t => {
  const { store, hooks, closed, file, info } = await fakeStore(t);
  await store.document(file, info);
  const close = hooks.close;
  hooks.close = async () => { throw new Error('close failed'); };
  await assert.rejects(store.sweep(() => false, Date.now() + 1_000_000, 0), /close failed/);
  hooks.close = close;
  await store.sweep(() => false, Date.now() + 1_000_000, 0);
  assert.equal(closed.length, 1);
});

test('failed renders can be retried and worker results are not cached', async t => {
  const { store, hooks, file } = await fakeStore(t);
  let renders = 0;
  hooks.render = async () => {
    if (++renders === 1) throw new Error('render failed');
    return new Uint8Array([1, 2, 3]);
  };
  await assert.rejects(store.page(file, 1), /render failed/);
  for (let index = 0; index < 2; index++) {
    const image = await store.page(file, 1);
    assert.deepEqual(new Uint8Array(image.body), new Uint8Array([1, 2, 3]));
  }
  assert.equal(renders, 3);
});

test('closing one MuPDF document does not affect another', async t => {
  const { store, file: first, info } = await setup(t);
  const second = join(first, '..', 'second.pdf');
  await writeFile(second, samplePdf(400, 500));
  const a = await store.document(first, info), b = await store.document(second, await stat(second));
  assert.deepEqual([a.pages[0], b.pages[0]], [{ width: 200, height: 300 }, { width: 400, height: 500 }]);
  await store.sweep(file => file === second, Date.now() + 1_000_000, 0);
  const retained = await store.page(second, 1, 450);
  assert.equal((await sharp(Buffer.from(retained.body)).metadata()).height, 563);
  const reopened = await store.page(first, 1, 450);
  assert.equal((await sharp(Buffer.from(reopened.body)).metadata()).height, 675);
});
