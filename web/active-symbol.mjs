// An outline click owns selection only while its actual scroll position holds.
export function symbolSelectionAt(selection, top) {
  return selection?.top === top ? selection : null;
}

export function activeSymbolId(symbols, position) {
  if (symbols.some(symbol => symbol.id === position?.symbolId)) return position.symbolId;
  const key = Number.isFinite(position?.line) ? 'line'
    : Number.isFinite(position?.page) ? 'page' : null;
  if (!key || !symbols.length) return null;
  const value = position[key];
  let active = null;
  for (const symbol of symbols) {
    const at = Number(symbol[key]);
    if (!Number.isFinite(at)) continue;
    if (at > value) break;
    active = symbol.id;
  }
  return active || symbols.find(symbol => Number.isFinite(Number(symbol[key])))?.id || null;
}

export function revealSymbolVertically(container, item) {
  if (!container || !item) return;
  const viewport = container.getBoundingClientRect(), row = item.getBoundingClientRect();
  if (row.top < viewport.top) container.scrollTop -= viewport.top - row.top;
  else if (row.bottom > viewport.bottom) container.scrollTop += row.bottom - viewport.bottom;
}
