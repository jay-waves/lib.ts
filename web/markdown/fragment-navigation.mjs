// Scope fragment lookup to this preview: retained reader tabs may share IDs.
export function navigateMarkdownFragment(root, link, current, updateHeadings = () => {}) {
  if (!link.hash || link.origin !== current.origin || link.pathname !== current.pathname
    || link.search !== current.search) return false;
  let id;
  try { id = decodeURIComponent(link.hash.slice(1)); }
  catch { return true; }
  const target = [...root.querySelectorAll('[id]')].find(node => node.id === id);
  // A missing local fragment must not fall through to document navigation.
  if (!target) return true;
  for (let section = target.closest('.heading-section'); section;
    section = section.parentElement?.closest('.heading-section')) section.classList.remove('is-collapsed');
  for (let details = target.parentElement?.closest('details'); details;
    details = details.parentElement?.closest('details')) details.open = true;
  updateHeadings(root);
  const panel = root.closest('.main-panel');
  if (panel) {
    const inset = (panel.querySelector('.file-toolbar')?.getBoundingClientRect().height || 0) + 12;
    const top = panel.scrollTop + target.getBoundingClientRect().top
      - panel.getBoundingClientRect().top - panel.clientTop - inset;
    panel.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  } else target.scrollIntoView({ block: 'start' });
  const history = root.ownerDocument.defaultView.history;
  history.replaceState(history.state, '', link.href);
  return true;
}
