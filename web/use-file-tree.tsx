import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTreeResource } from './tree-resource';
import { getFileTree, watchFileTree } from './api/library';
import type { FileTree } from './api/contracts';

interface FileTreeState {
  tree: FileTree | null;
  loading: boolean;
  error: string;
}

export function useFileTree(apiBase: string, selected: string, active = true) {
  const resource = useMemo(
    () => createTreeResource(signal => getFileTree(apiBase, signal)),
    [apiBase],
  );
  const [state, setState] = useState<FileTreeState>({ tree: null, loading: true, error: '' });
  const update = useCallback((path: string, force = false) => {
    if (force || !resource.has(path)) setState(previous => ({ ...previous, loading: true, error: '' }));
    return (force ? resource.invalidate() : resource.ensure(path)).then(tree => {
      setState(previous => previous.tree === tree && !previous.loading && !previous.error
        ? previous : { tree, loading: false, error: '' });
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        setState(previous => ({ ...previous, loading: false, error: String(error) }));
    });
  }, [resource]);
  const refresh = useCallback(() => update('', true), [update]);
  useEffect(() => {
    if (!apiBase) {
      setState({ tree: null, loading: false, error: '' });
      return;
    }
    if (active) void update(selected);
  }, [apiBase, selected, update, active]);
  useEffect(() => {
    if (!active || !apiBase) return;
    let disposed = false;
    // Compare the server snapshot after any pending load completes. This also
    // catches changes between the initial HTTP response and SSE connection.
    const synchronize = (revision: string) => {
      void resource.ensure('').then(tree => {
        if (!disposed && BigInt(tree.revision || 0) < BigInt(revision)) void refresh();
      }).catch((error: unknown) => {
        if (!disposed && !(error instanceof DOMException && error.name === 'AbortError')) void refresh();
      });
    };
    const stream = watchFileTree(apiBase, synchronize);
    return () => { disposed = true; stream.close(); };
  }, [apiBase, resource, refresh, active]);
  useEffect(() => () => resource.dispose(), [resource]);
  return { ...state, index: resource.index, refresh };
}
