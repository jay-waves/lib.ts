// Data watchers follow visibility. Explicit commands can opt into background
// delivery; focus never determines whether a visible page can receive updates.
/** @param {string} url @param {Record<string, (event: MessageEvent) => void>} handlers @param {{document?: Document, window?: Window, EventSource?: typeof EventSource, keepInBackground?: boolean}} [options] */
export function visibleEvents(url, handlers, options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;
  const EventSourceImpl = options.EventSource ?? globalThis.EventSource;
  const { keepInBackground = false } = options;
  let stream = null;
  let disposed = false, suspended = false;
  const update = () => {
    if (disposed || suspended || (!keepInBackground && doc.hidden)) {
      stream?.close();
      stream = null;
    } else if (!stream) {
      stream = new EventSourceImpl(url);
      for (const [event, handler] of Object.entries(handlers))
        stream.addEventListener(event, handler);
    }
  };
  const hide = () => { suspended = true; update(); };
  const show = () => {
    suspended = false;
    update();
  };
  win?.addEventListener('pagehide', hide);
  win?.addEventListener('pageshow', show);
  doc.addEventListener('visibilitychange', update);
  update();
  return {
    close() {
      disposed = true;
      win?.removeEventListener('pagehide', hide);
      win?.removeEventListener('pageshow', show);
      doc.removeEventListener('visibilitychange', update);
      update();
    },
  };
}
