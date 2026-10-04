import { watch } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

const watchers = new Map();
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

// One recursive watcher per repository, shared by its open tabs.
export function watchLibraryTree(root, notify, dataDirectory) {
  root = resolve(root);
  if (dataDirectory) dataDirectory = resolve(dataDirectory);
  const key = `${pathKey(root)}\0${dataDirectory ? pathKey(dataDirectory) : ''}`;
  let entry = watchers.get(key);
  if (!entry) {
    const subscribers = new Set();
    let timer;
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename != null) {
        const file = resolve(root, String(filename));
        const parts = relative(root, file).split(/[\\/]/);
        if (parts.some(part => part.startsWith('.') || part === 'node_modules')) return;
        if (dataDirectory) {
          const rel = relative(dataDirectory, file);
          if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')) return;
        }
      }
      // A fixed delay batches bursts without postponing updates indefinitely.
      timer ||= setTimeout(() => { timer = undefined; for (const subscriber of subscribers) subscriber(); }, 150);
    });
    watcher.on('error', error => { for (const subscriber of [...subscribers]) subscriber(error); });
    entry = { subscribers, close() { clearTimeout(timer); watcher.close(); } };
    watchers.set(key, entry);
  }
  entry.subscribers.add(notify);
  return () => {
    entry.subscribers.delete(notify);
    if (!entry.subscribers.size && watchers.get(key) === entry) {
      watchers.delete(key);
      entry.close();
    }
  };
}
