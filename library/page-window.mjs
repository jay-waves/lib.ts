// A one-page runway avoids replacing images on small boundary reversals.
export function nextPageWindow(previous, firstVisible, lastVisible, pageCount) {
  const first = Math.max(1, firstVisible - 1), last = Math.min(pageCount, lastVisible + 1);
  if (first >= previous.first && last <= previous.last && previous.last <= pageCount
    && previous.last - previous.first <= last - first + 2) return previous;
  return { first: Math.max(1, firstVisible - 2), last: Math.min(pageCount, lastVisible + 2) };
}

export function observePageWindow(root, pageCount, onChange, Observer = globalThis.IntersectionObserver, initialWindow) {
  let window = initialWindow || { first: 1, last: Math.min(3, pageCount) };
  onChange(window);
  const visible = new Set();
  const observer = new Observer(entries => {
    for (const entry of entries) {
      const page = Number(entry.target.dataset.page);
      if (entry.isIntersecting) visible.add(page); else visible.delete(page);
    }
    if (!visible.size) return;
    const next = nextPageWindow(window, Math.min(...visible), Math.max(...visible), pageCount);
    if (next !== window) { window = next; onChange(window); }
  }, { root: root.closest('.document-viewport') });
  root.querySelectorAll('[data-page]').forEach(page => observer.observe(page));
  return () => observer.disconnect();
}
