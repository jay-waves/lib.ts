import { indexFileTree } from './file-tree.mjs';
import type { TreeNode } from './api/contracts';

// One tree per tab; known-path navigation never needs another full scan.
export function createTreeResource<T extends { children: TreeNode[] }>(load: (signal: AbortSignal) => Promise<T>) {
  let tree: T | undefined;
  let index = new Map<string, TreeNode>();
  let pending: Promise<T> | undefined;
  let controller: AbortController | undefined;
  let revision = 0;
  function refresh() {
    if (pending) return pending;
    controller = new AbortController();
    const { signal } = controller;
    const operation = (async () => {
      let value: T, started: number;
      do {
        started = revision;
        value = await load(signal);
        signal.throwIfAborted();
      } while (started !== revision);
      tree = value;
      index = indexFileTree(value.children);
      return value;
    })().finally(() => { if (pending === operation) pending = undefined; });
    pending = operation;
    return operation;
  }
  const has = (path: string) => Boolean(tree) && (!path || index.has(path));
  return {
    has,
    get index() { return index; },
    ensure: (path: string) => tree && has(path) ? Promise.resolve(tree) : refresh(),
    refresh,
    invalidate() { revision++; return refresh(); },
    dispose() { controller?.abort(); pending = tree = undefined; index = new Map(); },
  };
}
