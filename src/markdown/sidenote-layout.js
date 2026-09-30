// Sidenotes have zero grid height on wide screens so they cannot push prose
// down. Move later notes only when they would overlap an earlier one.
export function observeSidenotes(root) {
  let frame = 0;
  const resizeObserver = new ResizeObserver(schedule);
  const observed = new Set([root]);
  resizeObserver.observe(root);

  function layout() {
    frame = 0;
    const notes = [...root.querySelectorAll(':scope > aside, .heading-content > aside')];
    for (const note of notes) note.style.transform = '';

    const current = new Set([root]);
    for (const note of notes) {
      for (const child of note.children) {
        current.add(child);
        if (!observed.has(child)) resizeObserver.observe(child);
      }
    }
    for (const element of observed) {
      if (!current.has(element)) resizeObserver.unobserve(element);
    }
    observed.clear();
    for (const element of current) observed.add(element);

    if (window.matchMedia('(max-width: 1000px)').matches) return;
    let previousBottom = -Infinity;
    for (const note of notes) {
      if (!note.getClientRects().length) continue;
      const top = note.getBoundingClientRect().top;
      const offset = Math.max(0, previousBottom + 16 - top);
      if (offset) note.style.transform = `translateY(${offset}px)`;
      previousBottom = top + offset + note.scrollHeight;
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(layout);
  }

  const mutationObserver = new MutationObserver(schedule);
  mutationObserver.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  window.addEventListener('resize', schedule);
  schedule();

  return () => {
    cancelAnimationFrame(frame);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
