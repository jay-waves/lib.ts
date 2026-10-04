import { resolve } from 'node:path';
import { gitStatus } from './git-status.mjs';

// The server owns this cache: browser tabs share both results and in-flight work.
// A disconnected HTTP client must not cancel a query used by another tab.
export function createGitStatusCache({ read = gitStatus, ttl = 4000, now = Date.now, limit = 128 } = {}) {
  const entries = new Map();
  return function status(root, { force = false } = {}) {
    root = resolve(root);
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    let entry = entries.get(key);
    if (entry?.pending) return entry.pending;
    if (!force && entry?.value && now() - entry.time < ttl) return Promise.resolve(entry.value);
    if (!entry) {
      if (entries.size >= limit) {
        for (const [id, item] of entries) {
          if (!item.pending) { entries.delete(id); break; }
        }
      }
      entry = {};
      entries.set(key, entry);
    }
    entry.pending = Promise.resolve().then(() => read(root)).then(value => {
      entry.value = value;
      entry.time = now();
      return value;
    }).catch(error => {
      entries.delete(key);
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
}

export const sharedGitStatus = createGitStatusCache();
