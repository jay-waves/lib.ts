import { useEffect, useSyncExternalStore } from 'react';
import { apiBase } from './urls.mjs';
import { createGitResource } from './git-resource.ts';

const resource = createGitResource(`${apiBase}/git/status`);
export function useGitStatus(active: boolean) {
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot);
  useEffect(() => active ? resource.retain() : undefined, [active]);
  return { ...state, refresh: resource.refresh };
}
