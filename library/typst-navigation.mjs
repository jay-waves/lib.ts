import { lineForPosition, positionForLine } from '../typst-anchors.mjs';
import { markdownLineAtViewport, markdownTopForLine } from './markdown-position.mjs';

export function sourceLineAtViewport(panel, document, view, inset) {
  const viewport = view === 'preview' && (panel.matches?.('.document-viewport') ? panel : panel.querySelector?.('.document-viewport'));
  if (viewport) { panel = viewport; inset = 12; }
  if (view !== 'raw' && document.type === 'markdown')
    return markdownLineAtViewport(panel, document.lineCount, inset);
  const y = panel.getBoundingClientRect().top + panel.clientTop + inset;
  if (view === 'raw') {
    const lines = panel.querySelectorAll('.raw-line-numbers span');
    let low = 0, high = lines.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle].getBoundingClientRect().bottom > y) high = middle;
      else low = middle + 1;
    }
    return lines.length ? Math.min(lines.length, low + 1) : undefined;
  }
  const pages = [...panel.querySelectorAll('div.typst-page[data-page]')];
  const index = pages.findIndex(page => page.getBoundingClientRect().bottom > y);
  const pageIndex = index < 0 ? pages.length - 1 : index;
  const rect = pages[pageIndex]?.getBoundingClientRect();
  if (!rect?.height) return;
  return lineForPosition(pageIndex + 1, Math.max(0, Math.min(1, (y - rect.top) / rect.height)),
    document.anchors || [], document.pages || []);
}

function outlineViewportTop(panel) {
  const top = panel.getBoundingClientRect().top + panel.clientTop;
  const toolbar = panel.closest?.('.main-panel')?.querySelector('.file-toolbar');
  const visibleTop = Math.max(top, toolbar?.getBoundingClientRect().bottom ?? top);
  // Compiler heading anchors can sit on the text baseline; leave room above it.
  return visibleTop + 28;
}

export function scrollToTypstSource(panel, document, view, line, inset, { position, behavior = 'instant', navigation = 'source' } = {}) {
  const viewport = view === 'preview' && (panel.matches?.('.document-viewport') ? panel : panel.querySelector?.('.document-viewport'));
  if (viewport) { panel = viewport; inset = 12; }
  let target, fraction = 0;
  if (view === 'raw') target = panel.querySelector(`#L${line}`);
  else if (document.type === 'markdown') {
    const top = markdownTopForLine(panel, document.lineCount, line);
    if (top !== undefined) panel.scrollTo({ top: Math.max(0, top - inset), behavior });
    return;
  } else {
    const point = position || positionForLine(line, document.anchors || [], document.pages || []);
    if (!point) return;
    target = panel.querySelectorAll('div.typst-page[data-page]')[point.page - 1];
    fraction = point.y;
  }
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const viewportTop = navigation === 'outline' && document.type === 'typst' && view === 'preview'
    ? outlineViewportTop(panel)
    : panel.getBoundingClientRect().top + panel.clientTop + inset;
  panel.scrollTo({ top: Math.max(0, panel.scrollTop + rect.top + fraction * rect.height
    - viewportTop), behavior });
}
