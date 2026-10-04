import { statSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';

function signature(file) {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

const watchedFiles = new Map();
const watchedDirectories = new Map();
const dirtyFiles = new Set();
let flushTimer;
let firstChange = 0;

function fileKey(file) {
  const path = resolve(file);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function flush() {
  flushTimer = undefined;
  firstChange = 0;
  const changes = new Map();
  const dirty = [...dirtyFiles];
  dirtyFiles.clear();
  for (const key of dirty) {
    const entry = watchedFiles.get(key);
    if (!entry) continue;
    const next = signature(entry.file);
    if (next === entry.signature) continue;
    entry.signature = next;
    for (const subscriber of entry.subscribers) {
      let change = changes.get(subscriber);
      if (!change) { change = { documentChanged: false, assets: [] }; changes.set(subscriber, change); }
      if (entry.kinds.get(subscriber) === 'document') change.documentChanged = true;
      else change.assets.push(entry.file);
    }
  }
  for (const [subscriber, change] of changes) {
    if (change.documentChanged || change.assets.length) subscriber.notify(change);
  }
}

function schedule() {
  if (!firstChange) firstChange = Date.now();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, Date.now() - firstChange >= 500 ? 0 : 150);
}

function registerDirectory(file) {
  const directory = dirname(file);
  const key = fileKey(directory);
  let entry = watchedDirectories.get(key);
  if (!entry) {
    const watcher = watch(directory, (_event, filename) => {
      if (filename != null) {
        const changed = Buffer.isBuffer(filename) ? filename.toString() : String(filename);
        const key = fileKey(resolve(directory, changed));
        if (!entry.files.has(key)) return;
        dirtyFiles.add(key);
      } else {
        for (const key of entry.files.keys()) dirtyFiles.add(key);
      }
      schedule();
    });
    entry = { watcher, files: new Map() };
    watcher.on('error', () => {
      for (const key of entry.files.keys()) dirtyFiles.add(key);
      schedule();
    });
    watchedDirectories.set(key, entry);
  }
  const pathKey = fileKey(file);
  if (!entry.files.has(pathKey)) {
    entry.files.set(pathKey, resolve(file));
  }
  return key;
}

function unregisterDirectory(directoryKey, fileKeyValue) {
  const directory = watchedDirectories.get(directoryKey);
  if (!directory) return;
  directory.files.delete(fileKeyValue);
  if (!directory.files.size) {
    watchedDirectories.delete(directoryKey);
    directory.watcher.close();
  }
}

export function watchLibraryFiles(documentFile, assetFiles, notify) {
  const subscriber = { notify };
  const files = new Map([[fileKey(documentFile), { file: resolve(documentFile), kind: 'document' }]]);
  for (const file of assetFiles) {
    const key = fileKey(file);
    if (!files.has(key)) files.set(key, { file: resolve(file), kind: 'asset' });
  }
  const registrations = [];
  function stop() {
    for (const [key, directory] of registrations) {
      const entry = watchedFiles.get(key);
      if (!entry) continue;
      entry.subscribers.delete(subscriber);
      entry.kinds.delete(subscriber);
      if (!entry.subscribers.size) {
        watchedFiles.delete(key);
        unregisterDirectory(directory, key);
      }
    }
  }
  try {
    for (const [key, item] of files) {
      let entry = watchedFiles.get(key);
      if (!entry) {
        entry = { file: item.file, signature: signature(item.file), subscribers: new Set(), kinds: new Map(), directory: registerDirectory(item.file) };
        watchedFiles.set(key, entry);
      }
      entry.subscribers.add(subscriber);
      entry.kinds.set(subscriber, item.kind);
      registrations.push([key, entry.directory]);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return stop;
}
