// Data watchers follow visibility. Explicit commands can opt into background
// delivery; focus never determines whether a visible page can receive updates.
export function visibleEvents(url, handlers, {
  document = globalThis.document, window = globalThis.window, EventSource = globalThis.EventSource,
  keepInBackground = false,
} = {}) {
  let stream = null, disposed = false, suspended = false;
  const update = () => {
    if (disposed || suspended || (!keepInBackground && document.hidden)) {
      stream?.close();
      stream = null;
    } else if (!stream) {
      stream = new EventSource(url);
      for (const [event, handler] of Object.entries(handlers)) stream.addEventListener(event, handler);
    }
  };
  const hide = () => { suspended = true; update(); };
  const show = () => {
    suspended = false;
    update();
  };
  window?.addEventListener('pagehide', hide);
  window?.addEventListener('pageshow', show);
  document.addEventListener('visibilitychange', update);
  update();
  return {
    close() {
      disposed = true;
      window?.removeEventListener('pagehide', hide);
      window?.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', update);
      update();
    },
  };
}
