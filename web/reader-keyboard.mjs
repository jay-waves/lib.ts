// The application delegates input; the reader decides whether its content pages.
export function pageReaderOnSpace(event, panel, type, view) {
  if (!panel || (view !== 'raw' && !['pdf', 'typst', 'markdown', 'html', 'image'].includes(type))) return;
  if (event.defaultPrevented || event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target?.isContentEditable || target?.closest?.('input, textarea, select, button, a[href], [role="button"], [role="slider"], [role="menu"]')) return;
  event.preventDefault();
  panel.scrollBy({ top: panel.clientHeight * 0.9, behavior: 'smooth' });
}
