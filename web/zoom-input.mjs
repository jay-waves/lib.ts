/**
 * Route zoom keys only while focus is inside the active reader. Capture at the
 * document so focused toolbar controls are covered without stealing focus.
 * @param {HTMLElement} viewport
 * @param {{wheel: (event: WheelEvent) => void, key: (direction: number, reset: boolean) => void, isEnabled?: () => boolean}} handlers
 */
export function bindZoomInput(viewport, { wheel, key, isEnabled = () => true }) {
  const document = viewport.ownerDocument;
  const onWheel = event => {
    if (!isEnabled() || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    wheel(event);
  };
  const onKey = event => {
    if (!isEnabled() || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const direction = ['+', '=', 'Add'].includes(event.key) ? 1 : ['-', '_', 'Subtract'].includes(event.key) ? -1 : 0;
    if (!direction && event.key !== '0') return;
    if (!viewport.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    key(direction, event.key === '0');
  };
  viewport.addEventListener('wheel', onWheel, { passive: false, capture: true });
  document.addEventListener('keydown', onKey, true);
  return () => {
    viewport.removeEventListener('wheel', onWheel, { capture: true });
    document.removeEventListener('keydown', onKey, { capture: true });
  };
}
