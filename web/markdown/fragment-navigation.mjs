import { fragmentTarget, revealBlock } from './block-navigation.mjs';
// Scope fragment lookup to this preview: retained reader tabs may share IDs.
export function navigateMarkdownFragment(root, link, current, updateHeadings = () => {}) {
  if (!link.hash || link.origin !== current.origin || link.pathname !== current.pathname
    || link.search !== current.search) return false;
  const target = fragmentTarget(root, link.hash);
  // A missing local fragment must not fall through to document navigation.
  if (!target) return true;
  revealBlock(target, root);
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
