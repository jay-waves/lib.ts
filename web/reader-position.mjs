import { pagePosition, restorePagePosition } from './reading-state.mjs';
import { sourceLineAtViewport, scrollToTypstSource } from './source-navigation.mjs';

export function readerPosition(panel, document, view, inset) {
  if (view === 'raw' || ['markdown', 'typst'].includes(document.type)) {
    return { line: sourceLineAtViewport(panel, document, view, inset), view };
  }
  const rect = panel.getBoundingClientRect();
  return { page: pagePosition(panel, rect.left + panel.clientWidth / 2, rect.top + inset) };
}

export function restoreReaderPosition(panel, document, view, position, inset) {
  // Line one is the document top, including its PathBar. Aligning the first
  // text line under the sticky toolbar would scroll the header away on open.
  if (position.line === 1 && !position.page && !position.position) {
    panel.scrollTo({ top: 0, behavior: 'instant' });
  } else if (view === 'preview' && position.page && ['pdf', 'image'].includes(document.type)) {
    const rect = panel.getBoundingClientRect();
    restorePagePosition(panel, position.page, rect.left + panel.clientWidth / 2, rect.top + inset);
  } else scrollToTypstSource(panel, document, view, position.line, inset, position);
}

export function navigateReaderSymbol(panel, document, view, symbol, inset, updateHeadings) {
  if (document.type === 'text' || document.type === 'typst' || (document.type === 'markdown' && view === 'raw')) {
    scrollToTypstSource(panel, document, view, symbol.line, inset,
      { position: symbol.position, behavior: 'instant', navigation: 'outline' });
    return true;
  }
  let target;
  if (document.type === 'markdown') {
    target = panel.querySelector(`#${CSS.escape(symbol.id)}`);
    for (let section = target?.parentElement?.closest('.heading-section'); section;
      section = section.parentElement?.closest('.heading-section')) section.classList.remove('is-collapsed');
    const root = panel.querySelector('.rendered-markdown');
    if (root) updateHeadings(root);
  } else if (document.type === 'pdf') target = panel.querySelectorAll('.pdf-page')[symbol.page - 1];
  if (!target) {
    if (document.type === 'markdown' && symbol.line) scrollToTypstSource(panel, document, view, symbol.line, inset);
    return false;
  }
  const rect = target.getBoundingClientRect();
  const withinPage = document.type === 'pdf' && Number.isFinite(symbol.y)
    ? Math.max(0, Math.min(1, symbol.y)) * rect.height : 0;
  const top = panel.scrollTop + rect.top + withinPage
    - panel.getBoundingClientRect().top - panel.clientTop - inset;
  panel.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  return true;
}
