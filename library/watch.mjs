import { statSync, watch } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

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
  for (const [key, entry] of watchedFiles) {
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
    const pathKey = fileKey(file);
    const watcher = watch(directory, (_event, filename) => {
      if (filename != null) {
        const changed = Buffer.isBuffer(filename) ? filename.toString() : String(filename);
        const matches = [...entry.files.values()].some(path => process.platform === 'win32'
          ? basename(path).toLowerCase() === changed.toLowerCase() : basename(path) === changed);
        if (!matches) return;
      }
      schedule();
    });
    entry = { watcher, files: new Map([[pathKey, resolve(file)]]) };
    watcher.on('error', schedule);
    watchedDirectories.set(key, entry);
  }
  const pathKey = fileKey(file);
  if (!entry.files.has(pathKey)) {
    entry.files.set(pathKey, resolve(file));
  }
  return key;
}

function unregisterDirectory(directoryKey, fileKeyValue, file) {
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
    for (const [key, directory] of registrations) {
      const entry = watchedFiles.get(key);
      entry?.subscribers.delete(subscriber);
      entry?.kinds.delete(subscriber);
      if (entry && !entry.subscribers.size) {
        watchedFiles.delete(key);
        unregisterDirectory(directory, key, entry.file);
      }
    }
    throw error;
  }
  return () => {
    for (const [key, directory] of registrations) {
      const entry = watchedFiles.get(key);
      if (!entry) continue;
      entry.subscribers.delete(subscriber);
      entry.kinds.delete(subscriber);
      if (!entry.subscribers.size) {
        watchedFiles.delete(key);
        unregisterDirectory(directory, key, entry.file);
      }
    }
  };
}
