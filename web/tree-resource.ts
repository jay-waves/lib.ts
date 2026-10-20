import { indexFileTree } from './file-tree.mjs';
import type { TreeNode } from './api/contracts';

// One request at a time bounds disk work. Each response publishes immediately,
// so a deep navigation does not hold the root listing until every branch loads.
export function createTreeResource<T extends { children: TreeNode[] }>(load: (signal: AbortSignal, path: string) => Promise<T>) {
  let tree: T | undefined;
  let index = new Map<string, TreeNode>();
  let pending: Promise<T> | undefined;
  let controller: AbortController | undefined;
  let current: string | undefined;
  const queued = new Set<string>();
  const listeners = new Set<(tree: T) => void>();
  function request(path = '', again = false): Promise<T> {
    if (current !== path || again) queued.add(path);
    if (pending) return pending;
    controller = new AbortController();
    const { signal } = controller;
    const operation = (async () => {
      while (queued.size) {
        current = queued.values().next().value!;
        queued.delete(current);
        const value = await load(signal, current);
        signal.throwIfAborted();
        tree = value;
        index = indexFileTree(value.children);
        for (const listener of listeners) listener(value);
      }
      return tree!;
    })().finally(() => {
      if (pending === operation) { pending = undefined; current = undefined; }
    });
    pending = operation;
    return operation;
  }
  const has = (path: string) => Boolean(tree) && (!path || index.has(path));
  const directoryLoaded = (path: string) => path ? index.get(path)?.children !== undefined : Boolean(tree);
  const ensureDirectory = (path: string) => directoryLoaded(path) ? Promise.resolve(tree!) : request(path);
  return {
    has,
    get index() { return index; },
    subscribe(listener: (tree: T) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureDirectory,
    async ensure(path: string) {
      if (!has(path)) await request(path.split('/').slice(0, -1).join('/'));
      return index.get(path)?.type === 'directory' ? ensureDirectory(path) : tree!;
    },
    refresh: () => request(''),
    invalidate: () => request('', true),
    dispose() {
      controller?.abort(); queued.clear(); pending = tree = current = undefined;
      index = new Map();
    },
  };
}
