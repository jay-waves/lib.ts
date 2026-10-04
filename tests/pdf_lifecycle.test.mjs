import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfStore, pdfDocument, pdfPage, prewarmPdfEngine, sweepPdfDocuments } from '../library/pdf.mjs';

function blankPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

test('PDFium prewarm leaves documents unopened and idle documents reopen on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-lifecycle-'));
  const file = join(directory, 'blank.pdf');
  try {
    await writeFile(file, blankPdf());
    await prewarmPdfEngine();
    const info = await stat(file);
    const document = await pdfDocument(file, info);
    assert.equal(document.pages.length, 1);
    assert.equal((await pdfPage(file, 1)).status, 200);
    await sweepPdfDocuments(() => false, Date.now() + 60_000, 0);
    assert.equal((await pdfPage(file, 1)).status, 200);
    await sweepPdfDocuments(() => false, Date.now() + 60_000, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fakeStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-revisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'book.pdf');
  await writeFile(file, blankPdf());
  const opened = [], closed = [];
  const task = work => ({ toPromise: () => Promise.resolve().then(work) });
  const pdf = {
    openDocumentBuffer: ({ id }) => task(() => {
      const document = { id, pages: [{ size: { width: 200, height: 200 } }] };
      opened.push(document);
      return document;
    }),
    getBookmarks: () => task(() => ({ bookmarks: [] })),
    renderPage: () => task(() => new Uint8Array([1])),
    closeDocument: document => task(() => { closed.push(document); }),
  };
  return { store: createPdfStore(() => pdf), pdf, opened, closed, file, info: await stat(file) };
}

test('an active PDF retains only the newest revision after the transition grace period', async t => {
  const { store, opened, closed, file, info } = await fakeStore(t);
  for (let revision = 0; revision < 5; revision++) await store.document(file, { ...info, mtimeMs: info.mtimeMs + revision });
  await store.sweep(() => true, Date.now() + 61_000);
  assert.equal(closed.length, 4);
  assert.ok(!closed.includes(opened.at(-1)));
  await store.sweep(() => false, Date.now() + 301_000);
  assert.equal(closed.length, 5);
  const metadata = await store.document(file, info);
  assert.equal(opened.length, 6);
  assert.equal(metadata.pdf, undefined, 'metadata consumers do not retain the native engine/document');
  assert.equal(metadata.document, undefined);
});

test('PDF cleanup protects an in-flight render and closes it after release', async t => {
  const { store, pdf, closed, file } = await fakeStore(t);
  const started = deferred(), rendered = deferred();
  pdf.renderPage = () => ({ toPromise() { started.resolve(); return rendered.promise; } });
  const page = store.page(file, 1);
  await started.promise;
  await store.sweep(() => false, Date.now() + 1_000_000, 0);
  assert.equal(closed.length, 0);
  rendered.resolve(new Uint8Array([1]));
  assert.equal((await page).status, 200);
  await store.sweep(() => false, Date.now() + 1_000_000, 0);
  assert.equal(closed.length, 1);
});

test('overlapping PDF cleanup closes once and reopening waits for native close', async t => {
  const { store, pdf, opened, closed, file, info } = await fakeStore(t);
  await Promise.all([store.document(file, info), store.document(file, info)]);
  assert.equal(opened.length, 1);
  const closing = deferred();
  pdf.closeDocument = document => ({ toPromise() { closed.push(document); return closing.promise; } });
  const sweep = store.sweep(() => false, Date.now() + 1_000_000, 0);
  await store.sweep(() => false, Date.now() + 1_000_000, 0);
  const reopened = store.document(file, info);
  assert.equal(closed.length, 1);
  assert.equal(opened.length, 1);
  closing.resolve();
  await sweep;
  await reopened;
  assert.equal(opened.length, 2);
});

test('multiple retained PDF documents stay open beyond the cache count target and close after repo exit', async t => {
  const { store, opened, closed, file } = await fakeStore(t);
  const retained = new Set();
  for (let index = 0; index < 6; index++) {
    const path = `${file}-${index}.pdf`;
    await writeFile(path, blankPdf());
    await store.document(path, await stat(path));
    retained.add(path);
  }
  await store.sweep(path => retained.has(path), Date.now() + 600_000);
  assert.equal(opened.length, 6); assert.equal(closed.length, 0);
  retained.clear();
  await store.sweep(path => retained.has(path), Date.now() + 600_000);
  assert.equal(closed.length, 6);
  await store.sweep(() => false, Date.now() + 600_000);
  assert.equal(closed.length, 6, 'closing is performed exactly once');
});
