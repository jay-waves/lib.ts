// Coordinates are relative to the scroll container, so scrolling never invalidates them.
const caches = new WeakMap();

function entryFor(panel) {
  if (!caches.has(panel)) caches.set(panel, { dirty: true, byTop: [], byLine: [] });
  return caches.get(panel);
}

export function observeMarkdownPosition(panel, root) {
  const entry = entryFor(panel);
  entry.dirty = true;
  const invalidate = () => { entry.dirty = true; };
  const win = root.ownerDocument.defaultView;
  const resize = new win.ResizeObserver(invalidate);
  const mutation = new win.MutationObserver(invalidate);
  const observed = new Set([panel, root]);
  resize.observe(panel);
  resize.observe(root);
  mutation.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  entry.mutation = mutation;
  entry.observeBlocks = blocks => {
    const current = new Set([panel, root, ...blocks]);
    for (const element of observed) if (!current.has(element)) resize.unobserve(element);
    for (const element of current) if (!observed.has(element)) resize.observe(element);
    observed.clear();
    for (const element of current) observed.add(element);
  };
  root.addEventListener('load', invalidate, true);
  root.addEventListener('error', invalidate, true);
  win.addEventListener('resize', invalidate);
  const fonts = root.ownerDocument.fonts;
  fonts?.addEventListener('loadingdone', invalidate);
  let disposed = false;
  fonts?.ready.then(() => { if (!disposed) invalidate(); });
  return () => {
    disposed = true;
    resize.disconnect();
    mutation.disconnect();
    root.removeEventListener('load', invalidate, true);
    root.removeEventListener('error', invalidate, true);
    win.removeEventListener('resize', invalidate);
    fonts?.removeEventListener('loadingdone', invalidate);
    if (caches.get(panel) === entry) caches.delete(panel);
  };
}

function positions(panel) {
  const entry = entryFor(panel);
  // Navigation can run in the same task as a DOM change, before observer delivery.
  if (entry.mutation?.takeRecords().length) entry.dirty = true;
  if (!entry.dirty) return entry;
  const nodes = [...panel.querySelectorAll('[data-source-line]')];
  const origin = panel.getBoundingClientRect().top + panel.clientTop;
  const scrollTop = panel.scrollTop || 0;
  const blocks = nodes.map(element => {
    const rect = element.getBoundingClientRect();
    return { line: Number(element.dataset.sourceLine) + 1,
      top: rect.top - origin + scrollTop, height: rect.height };
  }).filter(block => Number.isFinite(block.line) && block.height > 0);
  entry.byTop = blocks.slice().sort((a, b) => a.top - b.top || a.line - b.line);
  entry.byLine = blocks.slice().sort((a, b) => a.line - b.line || a.top - b.top);
  entry.observeBlocks?.(nodes);
  entry.dirty = false;
  return entry;
}

function upperBound(blocks, value, key) {
  let low = 0, high = blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle][key] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function markdownLineAtViewport(panel, lineCount, inset) {
  const blocks = positions(panel).byTop;
  if (!blocks.length) return;
  const y = (panel.scrollTop || 0) + inset;
  const index = Math.max(0, upperBound(blocks, y, 'top') - 1);
  const previous = blocks[index], next = blocks[index + 1];
  const span = next ? next.top - previous.top : Math.max(1, previous.height);
  const fraction = span > 0 ? Math.max(0, Math.min(1, (y - previous.top) / span)) : 0;
  const last = next ? next.line : lineCount || previous.line;
  return Math.max(1, Math.min(lineCount || last,
    Math.round(previous.line + fraction * (last - previous.line))));
}

export function markdownTopForLine(panel, lineCount, line) {
  const blocks = positions(panel).byLine;
  if (!blocks.length) return;
  const index = Math.max(0, upperBound(blocks, line, 'line') - 1);
  const previous = blocks[index], next = blocks[index + 1];
  const last = next ? next.line : lineCount || previous.line;
  const fraction = last > previous.line ? Math.max(0, Math.min(1, (line - previous.line) / (last - previous.line))) : 0;
  return previous.top + fraction * (next ? next.top - previous.top : previous.height);
}
