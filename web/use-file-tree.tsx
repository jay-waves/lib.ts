import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTreeResource } from './tree-resource';
import { getFileTree, watchFileTree } from './api/library';
import type { FileTree } from './api/contracts';

interface FileTreeState {
  tree: FileTree | null;
  loading: boolean;
  error: string;
}

export function useFileTree(apiBase: string, selected: string, active = true, showHidden = false) {
  const resource = useMemo(
    () => createTreeResource((signal, path) => getFileTree(apiBase, signal, showHidden, path)),
    [apiBase, showHidden],
  );
  const [state, setState] = useState<FileTreeState>({ tree: null, loading: true, error: '' });
  const current = useRef({ resource, selected });
  current.current = { resource, selected };
  useEffect(() => {
    setState({ tree: null, loading: Boolean(apiBase), error: '' });
    return resource.subscribe(tree => setState({ tree, loading: false, error: '' }));
  }, [resource, apiBase]);
  const update = useCallback((path: string, force = false, directory = false) => {
    if (force || !resource.has(path)) setState(previous => ({ ...previous, loading: true, error: '' }));
    return (force ? resource.invalidate() : directory ? resource.ensureDirectory(path) : resource.ensure(path)).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        setState(previous => ({ ...previous, loading: false, error: String(error) }));
    });
  }, [resource]);
  const loadDirectory = useCallback((path: string) => update(path, false, true), [update]);
  const refresh = useCallback(async () => {
    await update('', true);
    if (current.current.resource === resource) await update(current.current.selected);
  }, [update, resource]);
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
    const stream = watchFileTree(apiBase, synchronize, showHidden);
    return () => { disposed = true; stream.close(); };
  }, [apiBase, resource, refresh, active, showHidden]);
  useEffect(() => () => resource.dispose(), [resource]);
  return { ...state, index: resource.index, refresh, loadDirectory };
}
