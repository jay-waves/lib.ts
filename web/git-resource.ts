import { gitStatusSchema, type GitStatus } from './api/contracts.ts';
import { parseJsonResponse } from './api/client.ts';

export interface GitState {
  status: GitStatus | null;
  error: string;
  loading: boolean;
  updatedAt: number;
}

interface GitResourceOptions {
  fetch?: typeof globalThis.fetch;
  document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  interval?: number;
}

// One polling loop per repository in this page; the server deduplicates across pages.
export function createGitResource(url: string, { fetch: request = globalThis.fetch,
  document = globalThis.document, window = globalThis.window, interval = 5000 }: GitResourceOptions = {}) {
  let state: GitState = { status: null, error: '', loading: false, updatedAt: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let users = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<GitState>) => { state = { ...state, ...patch }; for (const notify of listeners) notify(); };
  const visible = () => users > 0 && !document?.hidden;
  function schedule() {
    clearTimeout(timer);
    if (visible()) timer = setTimeout(() => refresh(), state.error ? interval * 6 : interval);
  }
  function refresh(force = false) {
    if (pending) return pending;
    clearTimeout(timer);
    publish({ loading: true });
    pending = Promise.resolve().then(() => request(`${url}${force ? '?refresh=1' : ''}`, { cache: 'no-store' }))
      .then(async response => {
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Git API is unavailable. Restart the library service.');
        const status = await parseJsonResponse(response, gitStatusSchema, url);
        publish({ status, error: '', updatedAt: state.updatedAt + 1 });
      }).catch((error: unknown) => publish({ error: error instanceof Error ? error.message : String(error) }))
      .finally(() => { pending = null; publish({ loading: false }); schedule(); });
    return pending;
  }
  const wake = () => { if (visible()) void refresh(); else clearTimeout(timer); };
  return {
    getSnapshot: () => state,
    subscribe(notify: () => void) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    refresh,
    retain() {
      if (++users === 1) {
        document?.addEventListener('visibilitychange', wake);
        window?.addEventListener('focus', wake);
        wake();
      }
      return () => {
        if (--users === 0) {
          clearTimeout(timer);
          document?.removeEventListener('visibilitychange', wake);
          window?.removeEventListener('focus', wake);
        }
      };
    },
  };
}
