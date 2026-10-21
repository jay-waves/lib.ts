import { indexFileTree } from './file-tree.mjs';
import type { FileTree, TreeListing, TreeNode } from './api/contracts';

export function createTreeResource(load: (signal: AbortSignal, path: string) => Promise<TreeListing>) {
  const listings = new Map<string, TreeListing>();
  const requests = new Map<string, { promise: Promise<FileTree>; controller: AbortController }>();
  const listeners = new Set<(tree: FileTree) => void>();
  let tree: FileTree | undefined;
  let index = new Map<string, TreeNode>();
  let disposed = false;
  let refreshing: Promise<FileTree> | null = null;
  let refreshController: AbortController | null = null;

  function publish(path: string) {
    const listing = listings.get(path);
    if (!listing) return;
    const attachCachedChildren = (nodes: TreeNode[]): TreeNode[] => nodes.map(node => {
      if (node.type !== 'directory') return node;
      const loaded = listings.get(node.path);
      return loaded ? { ...node, children: attachCachedChildren(loaded.children) } : node;
    });
    const children = attachCachedChildren(listing.children);
    if (!path) {
      tree = { name: listing.name, absolutePath: listing.absolutePath, children, revision: listing.revision };
      index = indexFileTree(tree.children);
    } else if (tree) {
      const previous = index.get(path);
      let updated: TreeNode | undefined;
      const replace = (nodes: TreeNode[]): TreeNode[] => nodes.map(node => {
        if (node.path === path) {
          updated = { ...node, children };
          return updated;
        }
        if (node.type === 'directory' && path.startsWith(`${node.path}/`) && node.children) {
          const nested = replace(node.children);
          return nested.some((child, index) => child !== node.children![index]) ? { ...node, children: nested } : node;
        }
        return node;
      });
      tree = { ...tree, children: replace(tree.children) };
      if (updated) {
        const removeDescendants = (nodes: TreeNode[]) => nodes.forEach(node => {
          index.delete(node.path);
          if (node.children) removeDescendants(node.children);
        });
        if (previous?.children) removeDescendants(previous.children);
        index.set(path, updated);
        indexFileTree(children, index);
      }
    }
    if (!tree) return;
    for (const listener of listeners) listener(tree);
  }

  function request(path: string): Promise<FileTree> {
    if (disposed) return Promise.reject(new DOMException('Tree resource disposed', 'AbortError'));
    if (listings.has(path)) return Promise.resolve(tree!);
    const existing = requests.get(path);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = load(controller.signal, path).then(listing => {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      listings.set(path, listing);
      publish(path);
      return tree!;
    }).finally(() => {
      if (requests.get(path)?.promise === promise) requests.delete(path);
    });
    requests.set(path, { promise, controller });
    return promise;
  }

  async function ensureDirectory(path: string) {
    if (refreshing) await refreshing;
    if (listings.has(path)) return tree!;
    return request(path);
  }

  return {
    has(path: string) { return Boolean(tree) && (!path || index.has(path)); },
    get index() { return index; },
    subscribe(listener: (tree: FileTree) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureDirectory,
    async ensure(path: string) {
      if (!path) return ensureDirectory('');
      const parts = path.split('/');
      let directory = '';
      await ensureDirectory('');
      for (const part of parts.slice(0, -1)) {
        directory = directory ? `${directory}/${part}` : part;
        await ensureDirectory(directory);
      }
      const node = index.get(path);
      if (node?.type === 'directory') await ensureDirectory(path);
      return tree!;
    },
    invalidate() {
      if (refreshing) return refreshing;
      for (const { controller } of requests.values()) controller.abort();
      requests.clear();
      const controller = new AbortController();
      refreshController = controller;
      // Refresh only cached directories, parent first. Keep the published tree
      // and index intact until all surviving branches are ready to replace it.
      const paths = [...new Set(['', ...listings.keys()])].sort((a, b) =>
        a.split('/').length - b.split('/').length || a.localeCompare(b));
      refreshing = (async () => {
        const next = new Map<string, TreeListing>();
        for (const path of paths) {
          if (path) {
            const parent = path.split('/').slice(0, -1).join('/');
            if (!next.get(parent)?.children.some(node => node.path === path && node.type === 'directory')) continue;
          }
          const listing = await load(controller.signal, path);
          if (controller.signal.aborted || disposed) throw new DOMException('Aborted', 'AbortError');
          next.set(path, listing);
        }
        listings.clear();
        for (const [path, listing] of next) listings.set(path, listing);
        publish('');
        return tree!;
      })().finally(() => { refreshing = null; refreshController = null; });
      return refreshing;
    },
    dispose() {
      disposed = true;
      refreshController?.abort();
      for (const { controller } of requests.values()) controller.abort();
      requests.clear(); listings.clear(); listeners.clear(); tree = undefined; index = new Map();
    },
  };
}
