export const clampScale = scale => Math.min(4, Math.max(.2, scale));

export function fitDocumentPage(width, height, viewportWidth, viewportHeight) {
  const availableWidth = Math.max(1, viewportWidth - 48);
  const availableHeight = Math.max(1, viewportHeight - 48);
  const fitWidth = availableWidth / width;
  const fitPage = Math.min(fitWidth, availableHeight / height);
  const mode = fitPage >= fitWidth * .8 ? 'page' : 'width';
  return { mode, scale: clampScale(mode === 'page' ? fitPage : fitWidth) };
}

// All gestures operate on the same native two-axis scroll viewport.
export function bindViewportGestures(viewport, { zoom, getScale, onNavigate = () => {} }) {
  const pointers = new Map();
  let pan = null, pinch = null, suppressClick = false;
  const center = () => {
    const rect = viewport.getBoundingClientRect();
    return { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 };
  };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const wheel = event => {
    if (!(event.ctrlKey || event.metaKey)) {
      if (!event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX || 0)) {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
        onNavigate(event.deltaY * unit);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    zoom(clampScale(getScale() * Math.exp(-event.deltaY * unit * .0005)), { x: event.clientX, y: event.clientY });
  };
  const down = event => {
    // Native scrollbar input also starts user scrolling, without intercepting it.
    const bounds = viewport.getBoundingClientRect();
    if (event.button === 0 && event.clientX >= bounds.left + viewport.clientWidth) {
      onNavigate(0);
      return;
    }
    if (event.pointerType !== 'touch' && event.button !== 1) return;
    if (event.target.closest?.('button, input, textarea, select')) return;
    if (event.pointerType === 'touch' && event.target.closest?.('a')) return;
    // Keep native scrollbar interaction out of the document pan gesture.
    const rect = viewport.getBoundingClientRect();
    if (event.clientX >= rect.left + viewport.clientWidth || event.clientY >= rect.top + viewport.clientHeight) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    suppressClick = false;
    if (pointers.size === 2) { pinch = { ...pair(), scale: getScale() }; pan = null; }
    else pan = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  };
  const move = event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size >= 2) {
      const next = pair();
      zoom(clampScale(pinch.scale * next.distance / Math.max(1, pinch.distance)), { x: next.x, y: next.y },
        { x: pinch.x, y: pinch.y });
      pinch.x = next.x; pinch.y = next.y;
      suppressClick = true;
    } else if (pan) {
      const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
      if (!suppressClick && Math.hypot(dx, dy) < 3) return;
      suppressClick = true;
      viewport.classList.add('is-panning');
      onNavigate(previous.y - event.clientY);
      viewport.scrollTo({ left: pan.left - dx, top: pan.top - dy, behavior: 'instant' });
    }
  };
  const end = event => {
    pointers.delete(event.pointerId);
    pinch = null; pan = null;
    viewport.classList.remove('is-panning');
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    if (pointers.size >= 2) pinch = { ...pair(), scale: getScale() };
    else if (pointers.size === 1) {
      const point = [...pointers.values()][0];
      pan = { ...point, left: viewport.scrollLeft, top: viewport.scrollTop };
    }
  };
  const click = event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault(); event.stopPropagation();
  };
  const key = event => {
    if (!(event.ctrlKey || event.metaKey)) {
      const delta = event.key === ' ' ? viewport.clientHeight * (event.shiftKey ? -1 : 1) : { ArrowDown: 40, ArrowUp: -40, PageDown: viewport.clientHeight, PageUp: -viewport.clientHeight, Home: -viewport.scrollHeight, End: viewport.scrollHeight }[event.key];
      if (delta) onNavigate(delta);
      return;
    }
    if (event.altKey) return;
    const direction = ['+', '=', 'Add'].includes(event.key) ? 1 : ['-', '_', 'Subtract'].includes(event.key) ? -1 : 0;
    if (!direction && event.key !== '0') return;
    event.preventDefault(); event.stopPropagation();
    zoom(event.key === '0' ? 1 : clampScale(getScale() * Math.pow(1.05, direction)), center());
  };
  const listeners = { wheel, pointerdown: down, pointermove: move, pointerup: end,
    pointercancel: end, lostpointercapture: end, click, auxclick: click, keydown: key };
  for (const [type, handler] of Object.entries(listeners))
    viewport.addEventListener(type, handler, { passive: false, capture: type === 'click' || type === 'auxclick' });
  return () => {
    for (const [type, handler] of Object.entries(listeners)) viewport.removeEventListener(type, handler, type === 'click' || type === 'auxclick');
    viewport.classList.remove('is-panning');
    for (const id of pointers.keys()) if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
  };
}
