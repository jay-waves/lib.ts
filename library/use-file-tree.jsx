import { visibleEvents } from './visible-events.mjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createTreeResource } from './tree-resource.mjs';
import { repoId } from './urls.mjs';

export function useFileTree(apiBase, selected, active = true) {
  const resource = useMemo(() => createTreeResource(async signal => {
    const response = await fetch(`${apiBase}/tree`, { signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    // Older running services omit absolute paths from the tree response.
    if (!value.absolutePath) {
      const repositories = await fetch('/api/repos', { signal });
      const registry = await repositories.json();
      if (!repositories.ok) throw new Error(registry.error || `HTTP ${repositories.status}`);
      const repo = repoId ? registry.repos.find(repo => repo.slug === repoId || repo.id === repoId)
        : registry.repos.find(repo => repo.id === registry.defaultRepoId);
      value.absolutePath = repo?.root;
    }
    return value;
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
  useEffect(() => { void update(selected); }, [selected, update]);
  useEffect(() => {
    if (!active) return;
    // The initial tree request already covers the first connection. On later
    // reconnects, refresh to catch changes made while this tab was hidden.
    const stream = visibleEvents(`${apiBase}/library/tree-events`, {
      tree: refresh, connected: () => { if (resource.has('')) void refresh(); },
    });
    return () => {
      stream.close();
    };
  }, [apiBase, resource, refresh, active]);
  useEffect(() => () => resource.dispose(), [resource]);
  return { ...state, index: resource.index, refresh };
}
