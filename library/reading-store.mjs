import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { READING_RECORD_LIMIT, READING_FLUSH_INTERVAL } from './reading-policy.mjs';
import { validateBookmark } from './bookmark-model.mjs';

export const RECENT_FILES_LIMIT = READING_RECORD_LIMIT;

function validatePosition(position) {
  if (!position || typeof position !== 'object' || Array.isArray(position) || JSON.stringify(position).length > 65536)
    throw new Error('Invalid reading position');
}

// One bounded map per repository owns history dates and reading positions.
// Updates are immediate in memory; the first dirty update schedules a flush,
// so continued browsing cannot postpone persistence indefinitely.
export function createReadingStore(dataDirectory, { now = Date.now, flushInterval = READING_FLUSH_INTERVAL,
  io = { mkdir, readFile, writeFile, rename, rm }, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = error => console.error('Reading state flush failed:', error) } = {}) {
  const cache = new Map();
  let timer = null, flushTail = Promise.resolve(), closing = false;
  const directory = () => resolve(dataDirectory, 'reading');
  function filename(repo) {
    if (!/^[a-zA-Z0-9-]+$/.test(repo)) throw new Error('Invalid repository ID');
    return resolve(directory(), `${repo}.json`);
  }
  function getEntry(repo) {
    const file = filename(repo);
    if (cache.has(repo)) return cache.get(repo);
    const entry = { file, files: new Map(), revision: 0, persisted: 0, pending: Promise.resolve() };
    cache.set(repo, entry);
    entry.loaded = (async () => {
      let state;
      try { state = JSON.parse(await io.readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return; }
      const records = Array.isArray(state.files) ? state.files : [
        ...(state.recent || []).filter(path => Number.isFinite(Date.parse(state.recentVisitedAt?.[path])))
          .map(path => ({ path, lastVisitedAt: state.recentVisitedAt[path], position: state.positions?.[path] || {} })),
        ...Object.entries(state.positions || {}).map(([path, position]) => ({ path, position })),
      ];
      for (const record of records) {
        validateBookmark(record.path, false); validatePosition(record.position || {});
        if (entry.files.has(record.path)) continue;
        entry.files.set(record.path, { position: record.position || {},
          ...(Number.isFinite(Date.parse(record.lastVisitedAt)) ? { lastVisitedAt: record.lastVisitedAt } : {}) });
        if (entry.files.size >= RECENT_FILES_LIMIT) break;
      }
      if (!Array.isArray(state.files) || state.files.length > RECENT_FILES_LIMIT) { entry.revision++; schedule(); }
    })().catch(error => { cache.delete(repo); throw error; });
    return entry;
  }
  const dirty = () => [...cache.values()].some(entry => entry.revision !== entry.persisted);
  function schedule() {
    if (closing || timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      void flush().catch(onError).finally(() => { if (dirty()) schedule(); });
    }, flushInterval);
    timer?.unref?.();
  }
  function mutate(repo, update) {
    filename(repo);
    if (closing) return Promise.reject(new Error('Reading store is closed'));
    const entry = getEntry(repo);
    const operation = entry.pending.catch(() => {}).then(async () => {
      await entry.loaded;
      const changed = update(entry.files);
      if (changed !== false) { entry.revision++; schedule(); }
    });
    entry.pending = operation;
    return operation;
  }
  async function snapshot(repo, select) {
    const entry = getEntry(repo);
    await entry.pending.catch(() => {}); await entry.loaded;
    return select(entry.files);
  }
  function history(files) {
    const recent = [...files].filter(([, record]) => record.lastVisitedAt);
    return { recent: recent.map(([path]) => path), visitedAt: Object.fromEntries(recent.map(([path, record]) => [path, record.lastVisitedAt])) };
  }
  function flush() {
    const operation = flushTail.catch(() => {}).then(async () => {
      const results = await Promise.allSettled([...cache.values()].map(async entry => {
        await entry.pending.catch(() => {}); await entry.loaded;
        if (entry.revision === entry.persisted) return;
        const revision = entry.revision;
        const body = JSON.stringify({ files: [...entry.files].map(([path, record]) => ({ path, ...record })),
          updatedAt: new Date(now()).toISOString() }) + '\n';
        await io.mkdir(directory(), { recursive: true });
        const temporary = `${entry.file}.${randomUUID()}.tmp`;
        try { await io.writeFile(temporary, body, 'utf8'); await io.rename(temporary, entry.file); }
        finally { await io.rm(temporary, { force: true }); }
        // A mutation during the write remains dirty for the next flush.
        entry.persisted = revision;
      }));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
    flushTail = operation;
    return operation;
  }
  return {
    read: repo => snapshot(repo, files => Object.fromEntries([...files].filter(([, record]) => Object.keys(record.position).length)
      .map(([path, record]) => [path, structuredClone(record.position)]))),
    recent: repo => snapshot(repo, files => history(files).recent),
    recentHistory: repo => snapshot(repo, history),
    visit(repo, path) {
      validateBookmark(path, false);
      return mutate(repo, files => {
        const record = files.get(path) || { position: {} };
        files.delete(path);
        const retained = [...files]; files.clear();
        files.set(path, { ...record, lastVisitedAt: new Date(now()).toISOString() });
        for (const [key, value] of retained) if (files.size < RECENT_FILES_LIMIT) files.set(key, value);
      });
    },
    clearRecent: repo => mutate(repo, files => {
      for (const [path, record] of files) {
        if (Object.keys(record.position).length) files.set(path, { position: record.position });
        else files.delete(path);
      }
    }),
    save(repo, positions) {
      if (!positions || typeof positions !== 'object' || Array.isArray(positions)) throw new Error('Invalid reading positions');
      for (const [path, position] of Object.entries(positions)) { validateBookmark(path, false); validatePosition(position); }
      const updates = structuredClone(positions);
      return mutate(repo, files => {
        let changed = false;
        for (const [path, position] of Object.entries(updates)) {
          const record = files.get(path);
          // A delayed position batch must not resurrect an evicted historical file.
          if (!record && files.size >= RECENT_FILES_LIMIT) continue;
          const next = { ...record?.position, ...position };
          if (record && JSON.stringify(record.position) === JSON.stringify(next)) continue;
          files.set(path, { ...record, position: next }); changed = true;
        }
        return changed;
      });
    },
    flush,
    async close() {
      closing = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      await flush();
      while (dirty()) await flush();
    },
  };
}
