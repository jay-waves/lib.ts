export function readerView(document, requested = 'preview') {
  if (document.type === 'text') return 'raw';
  if (['image', 'pdf', 'binary'].includes(document.type)) return 'preview';
  return requested === 'raw' ? 'raw' : 'preview';
}

export function readerRouteRequest(path, search) {
  const query = new URLSearchParams(search);
  const line = Number(query.get('line')) || null;
  const index = Number(query.get('page')) - 1;
  const x = Number(query.get('x')), y = Number(query.get('y'));
  const page = query.has('page') && Number.isInteger(index) && index >= 0 && Number.isFinite(x) && Number.isFinite(y) ? { index, x, y } : null;
  return { path, line, page, view: query.get('view') || (line ? 'raw' : null) };
}

// One pending navigation owns restoration. New requests replace old work;
// unloaded content can retry without allowing intermediate positions to save.
export function createReaderNavigation(schedule, cancel) {
  let pending = null, frame = null;
  const retry = () => {
    if (!pending || frame !== null) return;
    const action = pending;
    frame = schedule(() => {
      frame = null;
      if (pending !== action) return;
      if (action() !== false && pending === action) pending = null;
    });
  };
  return {
    request(action) {
      if (frame !== null) cancel(frame);
      frame = null; pending = action; retry();
    },
    retry,
    get pending() { return pending !== null; },
    suspend() { if (frame !== null) cancel(frame); frame = null; },
    clear() { this.suspend(); pending = null; },
  };
}
