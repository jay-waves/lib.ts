// One critically damped animation keeps velocity continuous across wheel events.
// It only consumes requested distance; there is no extra inertial travel.
const MOUSE_WHEEL_SCALE = 0.4;
const RESPONSE = 25;
export function enableSmoothWheel(panel) {
  const win = panel.ownerDocument.defaultView;
  const reducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)');
  let boundsDirty = true, maxScroll = 0, viewportHeight = 0;
  const resizeObserver = new win.ResizeObserver(() => { boundsDirty = true; });
  resizeObserver.observe(panel);
  for (const child of panel.children) resizeObserver.observe(child);
  function updateBounds() {
    if (!boundsDirty) return;
    viewportHeight = panel.clientHeight;
    maxScroll = Math.max(0, panel.scrollHeight - viewportHeight);
    boundsDirty = false;
  }
  let target = null;
  let frame = null;
  let position = 0, velocity = 0, previousTime = 0, lastWritten = 0;
  function cancel() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    target = null;
    velocity = 0;
    boundsDirty = true;
  }
  function animate(time) {
    frame = null;
    // Another navigation/zoom/position restore takes priority over wheel motion.
    if (Math.abs(panel.scrollTop - lastWritten) > 2) { cancel(); return; }
    const dt = Math.max(0, (time - previousTime) / 1000);
    previousTime = time;
    updateBounds();
    target = Math.max(0, Math.min(maxScroll, target));
    const offset = position - target;
    const coefficient = velocity + RESPONSE * offset;
    const decay = Math.exp(-RESPONSE * dt);
    position = target + (offset + coefficient * dt) * decay;
    velocity = (velocity - RESPONSE * coefficient * dt) * decay;
    const settled = Math.abs(position - target) < 0.25 && Math.abs(velocity) < 2;
    if (settled) position = target;
    panel.scrollTo({ top: position, behavior: 'instant' });
    lastWritten = panel.scrollTop;
    if (settled) cancel();
    else frame = win.requestAnimationFrame(animate);
  }
  function wheel(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey
      || reducedMotion.matches || !event.cancelable || !event.deltaY
      || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      cancel();
      return;
    }
    // Touchpad input already has native momentum; avoid DOM checks for it.
    if (event.deltaMode === 0 && Math.abs(event.deltaY) < 40) { cancel(); return; }
    // Let nested scroll areas (code blocks, text fields, etc.) handle their input.
    for (let node = event.target; node && node !== panel; node = node.parentElement) {
      if (node.nodeType !== 1) continue;
      if (/^(TEXTAREA|INPUT|SELECT)$/.test(node.tagName)) { cancel(); return; }
      if (node.scrollHeight > node.clientHeight
        && /^(auto|scroll)$/.test(win.getComputedStyle(node).overflowY)) { cancel(); return; }
    }
    updateBounds();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewportHeight : 1;
    const delta = event.deltaY * unit * MOUSE_WHEEL_SCALE;
    if (!maxScroll) return;
    if (target !== null && Math.abs(panel.scrollTop - lastWritten) > 2) cancel();
    if (target === null) {
      position = lastWritten = panel.scrollTop;
      previousTime = win.performance.now();
    }
    // A direction change should respond immediately, without a queued tail.
    const base = target !== null && Math.sign(target - panel.scrollTop) === Math.sign(delta)
      ? target : panel.scrollTop;
    if (Math.sign(velocity) !== Math.sign(delta)) velocity = 0;
    target = Math.max(0, Math.min(maxScroll, base + delta));
    event.preventDefault();
    if (frame === null) frame = win.requestAnimationFrame(animate);
  }
  panel.addEventListener('wheel', wheel, { passive: false });
  panel.ownerDocument.addEventListener('pointerdown', cancel, true);
  panel.ownerDocument.addEventListener('keydown', cancel, true);
  panel.addEventListener('touchstart', cancel, { passive: true });
  reducedMotion.addEventListener('change', cancel);
  return () => {
    cancel();
    resizeObserver.disconnect();
    panel.removeEventListener('wheel', wheel);
    panel.ownerDocument.removeEventListener('pointerdown', cancel, true);
    panel.ownerDocument.removeEventListener('keydown', cancel, true);
    panel.removeEventListener('touchstart', cancel);
    reducedMotion.removeEventListener('change', cancel);
  };
}
