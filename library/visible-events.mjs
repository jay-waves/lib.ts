// Long-lived streams reserve browser connections. Keep them only in the focused,
// visible browsing context so inactive tabs and windows cannot starve new pages.
export function visibleEvents(url, handlers, {
  document = globalThis.document, window = globalThis.window, EventSource = globalThis.EventSource,
} = {}) {
  let stream = null, disposed = false, suspended = false;
  let focused = typeof window?.document?.hasFocus === 'function' ? window.document.hasFocus() : true;
  const update = () => {
    if (disposed || suspended || document.hidden || !focused) {
      stream?.close();
      stream = null;
    } else if (!stream) {
      stream = new EventSource(url);
      for (const [event, handler] of Object.entries(handlers)) stream.addEventListener(event, handler);
    }
  };
  const focus = () => { focused = true; update(); };
  const blur = () => { focused = false; update(); };
  const hide = () => { suspended = true; update(); };
  const show = () => {
    suspended = false;
    focused = typeof window?.document?.hasFocus === 'function' ? window.document.hasFocus() : true;
    update();
  };
  window?.addEventListener('pagehide', hide);
  window?.addEventListener('pageshow', show);
  document.addEventListener('visibilitychange', update);
  window?.addEventListener('focus', focus);
  window?.addEventListener('blur', blur);
  update();
  return {
    close() {
      disposed = true;
      window?.removeEventListener('pagehide', hide);
      window?.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', update);
      window?.removeEventListener('focus', focus);
      window?.removeEventListener('blur', blur);
      update();
    },
  };
}
