import { useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './urls.mjs';
import { createGitResource } from './git-resource.mjs';

const resource = createGitResource(`${apiBase}/git/status`);
export function useGitStatus(active) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useEffect(() => active ? resource.retain() : undefined, [active]);
  return { ...state, refresh: resource.refresh };
}
