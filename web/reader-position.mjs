import { pagePosition, restorePagePosition } from './reading-state.mjs';
import { sourceLineAtViewport, scrollToTypstSource } from './source-navigation.mjs';

export function readerPosition(panel, document, view, inset) {
  if (view === 'raw' || ['markdown', 'typst'].includes(document.type)) {
    return { line: sourceLineAtViewport(panel, document, view, inset), view };
  }
  const viewport = panel.querySelector('.document-viewport');
  if (!viewport) return {};
  const rect = viewport.getBoundingClientRect();
  return { page: pagePosition(viewport, rect.left + viewport.clientWidth / 2, rect.top + 12) };
}

export function restoreReaderPosition(panel, document, view, position, inset) {
  // The shell and reader can commit in separate renders. Wait until raw
  // content uses the shell's scroll container before restoring its line.
  if (view === 'raw' && panel.classList?.contains('has-document-viewport')) return false;
  const viewport = panel.querySelector('.document-viewport');
  if (view === 'preview' && position.page && ['pdf', 'image'].includes(document.type) && viewport) {
    const rect = viewport.getBoundingClientRect();
    restorePagePosition(viewport, position.page, rect.left + viewport.clientWidth / 2, rect.top + 12);
  } else scrollToTypstSource(panel, document, view, position.line, inset, position);
}

export function navigateReaderSymbol(panel, document, view, symbol, inset, updateHeadings) {
  const viewport = panel.querySelector('.document-viewport') || panel;
  if (document.type === 'typst' || (document.type === 'markdown' && view === 'raw')) {
    scrollToTypstSource(viewport, document, view, symbol.line, inset,
      { position: symbol.position, behavior: 'instant', navigation: 'outline' });
    return true;
  }
  let target;
  if (document.type === 'markdown') {
    target = viewport.querySelector(`#${CSS.escape(symbol.id)}`);
    for (let section = target?.parentElement?.closest('.heading-section'); section;
      section = section.parentElement?.closest('.heading-section')) section.classList.remove('is-collapsed');
    const root = viewport.querySelector('.rendered-markdown');
    if (root) updateHeadings(root);
  } else if (document.type === 'pdf') target = viewport.querySelectorAll('.pdf-page')[symbol.page - 1];
  if (!target) {
    if (document.type === 'markdown' && symbol.line) scrollToTypstSource(viewport, document, view, symbol.line, 12);
    return false;
  }
  const offset = viewport === panel ? inset : 12;
  const top = viewport.scrollTop + target.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top - viewport.clientTop - offset;
  viewport.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  return true;
}
