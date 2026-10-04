// Each browser page owns one lease, independently of its visibility/SSE streams.
export function retainDocument(endpoint, path, {
  window = globalThis.window, fetch = globalThis.fetch, client = globalThis.crypto.randomUUID(),
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval,
} = {}) {
  let version = 0, suspended = false;
  const send = (paths, keepalive = false) => {
    void fetch(`${endpoint}/library/session-leases`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, keepalive,
      body: JSON.stringify({ client, paths, version: ++version }),
    }).catch(() => {});
  };
  const renew = () => { if (!suspended) send([path]); };
  const hide = () => { suspended = true; send([], true); };
  const show = () => { suspended = false; renew(); };
  renew();
  const timer = setInterval(renew, 30000);
  window.addEventListener('pagehide', hide);
  window.addEventListener('pageshow', show);
  window.addEventListener('focus', renew);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
    window.removeEventListener('focus', renew);
    hide();
  };
}
