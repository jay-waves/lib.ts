// One polling loop per repository in this page; the server deduplicates across pages.
export function createGitResource(url, { fetch: request = globalThis.fetch,
  document = globalThis.document, window = globalThis.window, interval = 5000 } = {}) {
  let state = { status: null, error: '', loading: false, updatedAt: 0 };
  let timer, pending, users = 0, sequence = 0;
  const listeners = new Set();
  const publish = patch => { state = { ...state, ...patch }; for (const notify of listeners) notify(); };
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
        const status = await response.json();
        if (!response.ok) throw new Error(status.error || 'Could not read Git status.');
        publish({ status, error: '', updatedAt: ++sequence });
      }).catch(error => publish({ error: error.message }))
      .finally(() => { pending = null; publish({ loading: false }); schedule(); });
    return pending;
  }
  const wake = () => { if (visible()) void refresh(); else clearTimeout(timer); };
  return {
    getSnapshot: () => state,
    subscribe(notify) { listeners.add(notify); return () => listeners.delete(notify); },
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
