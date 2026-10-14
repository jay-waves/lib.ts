import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { sweepTypstCache } from './cache.mjs';
import { createByteCache, svgImageBytes } from '../../shared/byte-cache.mjs';
import { typstInputs, typstCompilationKey } from './inputs.mjs';
import { createWorkerRuntime } from '../worker-runtime.mjs';
import { requestFlight } from '../../shared/request-flight.mjs';
import { createTypstWorker } from './worker-client.mjs';

export function createTypstService({ root, emit = () => {}, profile, isActive = () => false, workerIdleMs = 60_000,
  workerFactory = createTypstWorker, artifactMaxBytes = 64 * 1024 * 1024,
  artifactLimit = 3, documentLimit = 64, documentMaxBytes = 16 * 1024 * 1024,
  versionsPerDocument = 2, versionGraceMs = 15000, maxCompilations = 256 }) {
  const documents = new Map(), compilations = new Map(), pendingCompiles = new Map();
  let retentionDirty = false, retentionTask;
  const images = createByteCache({ maxEntries: 64, maxBytes: 16 * 1024 * 1024,
    sizeOf: value => svgImageBytes(value.image), ttl: 5 * 60_000 });
  const worker = workerFactory({ root, emit, profile, artifactMaxBytes, artifactLimit, maxCompilations });
  const runtime = createWorkerRuntime({ worker, name: 'Typst', workerIdleMs, isActive: hasActiveDocument });
  const { run, scheduleIdle } = runtime;
  function pathKey(file) { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file); }
  function hasActiveDocument() { return [...documents.values()].some(item => isActive(item.file)); }
  async function restoreArtifact(item) {
    for (const [file, modified] of item.revisions) {
      const current = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (current?.mtimeMs !== modified) {
        const error = new Error('Document changed; reload its metadata');
        error.status = 410;
        throw error;
      }
    }
    const result = await worker.request('compile', item.request);
    if (result.fingerprint !== item.fingerprint || JSON.stringify(result.info) !== JSON.stringify(item.info)) {
      await worker.request('discard', item.id);
      const error = new Error('Document changed; reload its metadata');
      error.status = 410;
      throw error;
    }
  }
  async function compile(file, source, modified, { theme, signal } = {}) {
    runtime.assertOpen();
    signal?.throwIfAborted();
    const key = typstCompilationKey(pathKey(file), modified, typstInputs(theme));
    const cached = compilations.get(key);
    if (cached) { cached.lastUsed = Date.now(); return cached; }
    const id = randomBytes(12).toString('hex');
    const request = { id, file, source, theme };
    const taskKey = `compile:${typstCompilationKey(pathKey(file), '', typstInputs(theme))}`;
    return requestFlight(pendingCompiles, key, sharedSignal => run(async ({ assertCurrent }) => {
      const result = await worker.request('compile', request);
      try { assertCurrent(); runtime.assertOpen(); }
      catch (error) {
        // The engine has already allocated this artifact. Discard it before
        // releasing the queue slot; do not retain obsolete worker documents.
        if (worker.running) await worker.request('discard', id);
        throw error;
      }
      const item = { ...result, id, key, file, request, versionKey: taskKey,
        revisions: [[file, modified]],
        pendingPages: new Map(), lastUsed: Date.now(), inUse: 0 };
      documents.set(id, item);
      compilations.set(key, item);
      sweep(Date.now(), id);
      return item;
    }, { key: taskKey, signal: sharedSignal, bytes: source.length * 2 }), signal);
  }
  async function page(id, page, { signal, prefetch = false } = {}) {
    const item = documents.get(id);
    if (!item) throw Object.assign(new Error('Document expired; reload its metadata'), { status: 410 });
    if (!Number.isInteger(page) || page < 1 || page > item.info.length)
      throw Object.assign(new Error('Page unavailable'), { status: 404 });
    item.lastUsed = Date.now();
    item.inUse++;
    try {
      runtime.assertOpen();
      signal?.throwIfAborted();
      const key = `${id}:${page}`;
      let image = images.get(key)?.image;
      if (!image) {
        image = await requestFlight(item.pendingPages, page, sharedSignal => run(async ({ assertCurrent }) => {
          let image;
          try { image = await worker.request('page', { id, page }); }
          catch (error) {
            if (error.code !== 'ARTIFACT_MISSING') throw error;
            assertCurrent();
            await restoreArtifact(item);
            assertCurrent();
            image = await worker.request('page', { id, page });
          }
          assertCurrent();
          images.set(key, { id, image });
          return image;
        }, { signal: sharedSignal, priority: prefetch ? -1 : 1 }), signal);
      }
      return image;
    } finally {
      item.inUse--; item.lastUsed = Date.now();
      if (!runtime.closed) sweep();
    }
  }
  function scheduleRetention() {
    retentionDirty = true;
    if (retentionTask || runtime.closed || !worker.running) return;
    retentionTask = run(async () => {
      do {
        retentionDirty = false;
        await worker.request('retain', [...documents.keys()]);
      } while (retentionDirty);
    }, { touchIdle: false }).catch(error => {
      retentionDirty = false;
      emit({ event: 'notice', kind: 'typst', message: error.message });
    })
      .finally(() => {
        retentionTask = undefined;
        if (retentionDirty && !runtime.closed && worker.running) scheduleRetention();
      });
  }
  function sweep(now = Date.now(), protectedId = null) {
    const count = documents.size;
    sweepTypstCache(documents, { now, protectedId, isActive, fileKey: pathKey,
      versionKey: item => item.versionKey, maxBytes: documentMaxBytes, limit: documentLimit,
      maxVersions: versionsPerDocument, versionGraceMs });
    for (const [key, item] of compilations) if (!documents.has(item.id)) compilations.delete(key);
    for (const [key, image] of images) if (!documents.has(image.id)) images.delete(key);
    if (documents.size !== count) scheduleRetention();
    scheduleIdle();
  }
  async function close() {
    await runtime.close();
    documents.clear(); compilations.clear(); images.clear();
  }
  return { compile, page, sweep, close, file: id => documents.get(id)?.file };
}
