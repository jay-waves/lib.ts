import { blockForLine } from './block-navigation.mjs';
// Coordinates are relative to the scroll container, so scrolling never invalidates them.
const caches = new WeakMap();

function entryFor(panel) {
  if (!caches.has(panel)) caches.set(panel, { dirty: true, byTop: [] });
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
  const nodes = [...panel.querySelectorAll('[data-line]')];
  const origin = panel.getBoundingClientRect().top + panel.clientTop;
  const scrollTop = panel.scrollTop || 0;
  const blocks = nodes.map(element => {
    const rect = element.getBoundingClientRect();
    return { line: Number(element.dataset.line),
      top: rect.top - origin + scrollTop, height: rect.height };
  }).filter(block => Number.isFinite(block.line) && block.height > 0);
  entry.byTop = blocks.slice().sort((a, b) => a.top - b.top || a.line - b.line);
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
  return blocks[index].line;
}

export function markdownTopForLine(panel, lineCount, line) {
  const root = panel.querySelector('.rendered-markdown') || panel;
  const target = blockForLine(root, line);
  if (!target) return;
  for (let node = target.parentElement; node && node !== panel; node = node.parentElement) {
    if (node.classList.contains('heading-section')) node.classList.remove('is-collapsed');
    if (node.tagName === 'DETAILS') node.open = true;
  }
  return target.getBoundingClientRect().top - panel.getBoundingClientRect().top - panel.clientTop + (panel.scrollTop || 0);
}
