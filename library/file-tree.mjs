// Keep directories first and sort each level without mutating the server tree.
export function sortFileTree(nodes = []) {
  return nodes.map(node => node.children ? { ...node, children: sortFileTree(node.children) } : node)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      const time = value => Date.parse(value.modified) || 0;
      return time(b) - time(a) || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
}

// Modified clicks and middle clicks must retain the browser's native link behavior.
export function isPlainTreeActivation(event) {
  return !event.defaultPrevented && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
    && (event.button === undefined || event.button === 0);
}
export function indexFileTree(nodes = [], index = new Map()) {
  for (const node of nodes) {
    index.set(node.path, node);
    if (node.children) indexFileTree(node.children, index);
  }
  return index;
}

// Preserve only bookmarked leaves and their ancestor folders, in tree order.
export function filterBookmarkedTree(nodes = [], bookmarks = []) {
  const paths = new Set(bookmarks.map(bookmark => bookmark.path));
  function visit(entries) {
    return entries.flatMap(node => {
      if (node.type === 'directory') {
        const children = visit(node.children || []);
        return children.length ? [{ ...node, children }] : [];
      }
      return paths.has(node.path) ? [node] : [];
    });
  }
  return visit(nodes);
}

export function filterFileTree(nodes, query) {
  if (!query) return nodes || [];
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes || [];
  return (nodes || []).flatMap(node => {
    if (node.name.toLocaleLowerCase().includes(needle) || node.path.toLocaleLowerCase().includes(needle)) return [node];
    if (node.children) {
      const children = filterFileTree(node.children, needle);
      if (children.length) return [{ ...node, children }];
    }
    return [];
  });
}


// Flat file rows share real paths as keys, so equal basenames remain distinct.
export function fileListFromPaths(paths = []) {
  return [...new Set(paths)].map(path => ({ name: path.split('/').at(-1), path, type: 'file' }));
}

export function fileTreeForView(nodes, { bookmarksOnly = false, bookmarks = [], query = "" } = {}) {
  return bookmarksOnly ? filterBookmarkedTree(nodes, bookmarks) : filterFileTree(nodes, query);
}
