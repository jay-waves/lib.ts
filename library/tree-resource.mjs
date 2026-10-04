import { indexFileTree } from './file-tree.mjs';

// One tree per tab; known-path navigation never needs another full scan.
export function createTreeResource(load) {
  let tree, index = new Map(), pending, controller;
  let revision = 0;
  function refresh() {
    if (pending) return pending;
    controller = new AbortController();
    const { signal } = controller;
    const operation = (async () => {
      let value, started;
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
  const has = path => Boolean(tree) && (!path || index.has(path));
  return {
    has,
    get index() { return index; },
    ensure: path => has(path) ? Promise.resolve(tree) : refresh(),
    refresh,
    invalidate() { revision++; return refresh(); },
    dispose() { controller?.abort(); pending = tree = undefined; index = new Map(); },
  };
}
