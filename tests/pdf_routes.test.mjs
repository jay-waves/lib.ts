import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createLibraryRoutes } from '../server/routes.mjs';
import { samplePdf } from './fixtures/pdf.mjs';
import { createPdfService } from '../server/pdf/engine.mjs';

test('PDF page routes pass pixel width and revision to the worker service and reject invalid widths', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'pdf-routes-'));
  await writeFile(resolve(root, 'sample.pdf'), samplePdf());
  const calls = [];
  const app = createLibraryRoutes({ root, json: (value, status) => Response.json(value, { status }),
    checkedPath: path => resolve(root, path),
    pdf: { page(...args) { calls.push(args); return new Response('image'); } },
  });
  t.after(async () => { app.close(); await rm(root, { recursive: true, force: true }); });
  const request = query => app.request(`/api/pdf/page?path=sample.pdf&page=1${query}`);
  assert.equal((await request('&width=2250&v=revision')).status, 200);
  assert.deepEqual(calls[0], [resolve(root, 'sample.pdf'), 1, 2250, 'revision']);
  assert.equal((await request('')).status, 200);
  assert.equal(calls[1][2], 1800);
  for (const width of ['bad', 'Infinity', '0', '-1']) assert.equal((await request(`&width=${width}`)).status, 400);
  assert.equal(calls.length, 2);
});

test('PDF metadata revisions round-trip through real page requests with fractional file timestamps', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'pdf-revision-roundtrip-'));
  const file = resolve(root, 'sample.pdf');
  await writeFile(file, samplePdf());
  // stat.mtime rounds these sub-millisecond values; new Date(mtimeMs) truncates them.
  await utimes(file, 1700000000.9998, 1700000000.9998);
  const pdf = createPdfService({ isActive: () => true });
  const app = createLibraryRoutes({ root, json: (value, status) => Response.json(value, { status }),
    checkedPath: path => resolve(root, path), pdf });
  t.after(async () => { app.close(); await pdf.close(); await rm(root, { recursive: true, force: true }); });
  const metadata = await app.request('/api/document?path=sample.pdf');
  assert.equal(metadata.status, 200);
  const document = await metadata.json();
  const url = `${document.pages[0].url}&width=1800&v=${encodeURIComponent(document.modified)}`;
  const page = await app.request(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'image/webp');
  await utimes(file, 1700000002, 1700000002);
  assert.equal((await app.request(url)).status, 410, 'a genuinely changed file still rejects its old revision');
});
