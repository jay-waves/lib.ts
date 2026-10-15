import { visibleEvents } from './visible-events.mjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTreeResource } from './tree-resource.mjs';

export function useFileTree(apiBase, selected, active = true) {
  const resource = useMemo(() => createTreeResource(async signal => {
    const response = await fetch(`${apiBase}/tree`, { signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return { ...value, revision: response.headers.get('x-tree-revision') };
  }), [apiBase]);
  const [state, setState] = useState({ tree: null, loading: true, error: '' });
  const update = useCallback((path, force = false) => {
    if (force || !resource.has(path)) setState(previous => ({ ...previous, loading: true, error: '' }));
    return (force ? resource.invalidate() : resource.ensure(path)).then(tree => {
      setState(previous => previous.tree === tree && !previous.loading && !previous.error
        ? previous : { tree, loading: false, error: '' });
    }).catch(error => {
      if (error.name !== 'AbortError') setState(previous => ({ ...previous, loading: false, error: String(error) }));
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
    const synchronize = event => {
      const revision = JSON.parse(event.data).revision;
      void resource.ensure('').then(tree => {
        if (!disposed && BigInt(tree.revision || 0) < BigInt(revision)) void refresh();
      }).catch(error => {
        if (!disposed && error.name !== 'AbortError') void refresh();
      });
    };
    const stream = visibleEvents(`${apiBase}/library/tree-events`, {
      tree: synchronize, connected: synchronize,
    });
    return () => { disposed = true; stream.close(); };
  }, [apiBase, resource, refresh, active]);
  useEffect(() => () => resource.dispose(), [resource]);
  return { ...state, index: resource.index, refresh };
}
