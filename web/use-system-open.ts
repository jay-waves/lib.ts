import { startTransition, useActionState } from 'react';
import { openDirectory } from './api/library';
import { openMedia } from './api/media';
import { apiBase } from './urls.mjs';

// Both actions run on the service host. Views only render their pending/error state.
export function useSystemOpen(target: 'directory' | 'media', path = '') {
  const [error, dispatch, pending] = useActionState(async () => {
    try {
      await (target === 'directory' ? openDirectory(apiBase, path) : openMedia(apiBase, path));
      return '';
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return `Could not open ${target === 'directory' ? 'directory' : 'file'}: ${detail}`;
    }
  }, '');
  return { error, pending, open: () => startTransition(() => dispatch()) };
}
