// Main-thread PDF caches; MuPDF stays inside the worker.
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { createByteCache } from '../../shared/byte-cache.mjs';
import { normalizePdfWidth } from '../../shared/pdf-render.mjs';
import { createWorkerRuntime, singleFlight } from '../worker-runtime.mjs';
import { createWorkerClient } from '../worker-client.mjs';

export function createPdfService({ isActive = () => false, workerIdleMs = 60_000, emit, profile } = {}) {
  const documents = new Map(), opening = new Map(), rendering = new Map();
  const images = createByteCache({ maxEntries: 64, maxBytes: 8 * 1024 * 1024,
    sizeOf: image => image.body.byteLength, ttl: 60_000 });
  const worker = createWorkerClient({ name: 'MuPDF', url: new URL('./worker.mjs', import.meta.url), emit, profile });
  const runtime = createWorkerRuntime({ worker, name: 'PDF', workerIdleMs, isActive: hasActiveDocument });
  const { run, scheduleIdle } = runtime;
  function fileKey(file) { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file); }
  function documentKey(file, info) { return `${fileKey(file)}:${info.mtimeMs}:${info.size}`; }
  function hasActiveDocument() { return [...documents.values()].some(item => isActive(item.file)); }
  async function document(file, info) {
    runtime.assertOpen();
    const key = documentKey(file, info);
    const cached = documents.get(key);
    if (cached) { cached.lastUsed = Date.now(); return cached; }
    const revision = { mtimeMs: info.mtimeMs, size: info.size };
    return singleFlight(opening, key, () => run(async () => {
      const result = await worker.request('document', { file, info: revision });
      const item = { ...result, file, info: revision, lastUsed: Date.now() };
      documents.set(key, item);
      return item;
    }));
  }
  async function page(file, page, width = 1800, modified) {
    runtime.assertOpen();
    if (!Number.isInteger(page) || page < 1) return new Response('Page not found', { status: 404 });
    const info = await stat(file);
    if (modified && info.mtime.toISOString() !== modified)
      return new Response('Document changed; reload its metadata', { status: 410 });
    const targetWidth = normalizePdfWidth(width);
    const key = `${documentKey(file, info)}:${page}:${targetWidth}`;
    let image = images.get(key);
    if (!image) {
      image = await singleFlight(rendering, key, async () => {
        await document(file, info);
        return run(async () => {
          const image = await worker.request('page', { file, info: { mtimeMs: info.mtimeMs, size: info.size }, page, width: targetWidth });
          if (image.status === 200) images.set(key, image);
          return image;
        });
      });
    }
    return new Response(image.body, { status: image.status,
      headers: { 'content-type': 'image/webp', 'cache-control': 'no-store' } });
  }
  async function sweep(now = Date.now(), idleMs = 5 * 60_000) {
    const latest = new Map();
    for (const item of documents.values()) latest.set(fileKey(item.file), item);
    for (const [key, item] of documents) {
      if (opening.has(key) || (isActive(item.file) && latest.get(fileKey(item.file)) === item)) continue;
      const idle = now - item.lastUsed;
      if (idle >= idleMs || (idle >= 60_000 && (documents.size > 3 || latest.get(fileKey(item.file)) !== item))) documents.delete(key);
    }
    const retained = [...documents.keys()];
    for (const key of images.keys()) {
      if (!retained.some(document => key.startsWith(`${document}:`))) images.delete(key);
    }
    if (worker.running) await run(() => worker.request('sweep', {
      active: [...documents.values()].filter(item => isActive(item.file)).map(item => item.file), now, idleMs,
    }), false);
    scheduleIdle();
  }
  async function close() {
    await runtime.close();
    documents.clear(); images.clear();
  }
  return { document, page, sweep, close };
}

export const pdf = createPdfService();
