// Called by the preview's existing delegated click handler; no layout observers.
export function toggleFootnote(root, link) {
  const target = link.getAttribute('data-footnote-ref');
  const note = target ? [...root.querySelectorAll('.inline-footnote')].find(note => note.id === target) : link.closest('.inline-footnote');
  if (!note || (!target && !link.classList.contains('footnote-label'))) return false;
  const refs = [...root.querySelectorAll('[data-footnote-ref]')]
    .filter(ref => ref.getAttribute('data-footnote-ref') === note.id);
  note.hidden = target ? !note.hidden : true;
  for (const ref of refs) ref.setAttribute('aria-expanded', String(!note.hidden));
  if (target && !note.hidden) note.querySelector('.footnote-label')?.setAttribute('href', `#${link.id}`);
  if (!target) {
    const ref = refs.find(ref => `#${ref.id}` === link.getAttribute('href')) || refs[0];
    if (ref) {
      ref.focus({ preventScroll: true });
      const panel = root.closest('.main-panel');
      const bounds = panel?.getBoundingClientRect();
      const toolbar = panel?.querySelector('.file-toolbar')?.getBoundingClientRect();
      const rect = ref.getBoundingClientRect();
      const top = Math.max(bounds?.top || 0, toolbar?.bottom || 0) + 12;
      const bottom = bounds?.bottom ?? root.ownerDocument.defaultView.innerHeight;
      if (rect.top < top || rect.bottom > bottom) {
        if (panel) panel.scrollTo({ top: Math.max(0, panel.scrollTop + rect.top - top), behavior: 'instant' });
        else ref.scrollIntoView({ block: 'nearest' });
      }
    }
  }
  return true;
}
