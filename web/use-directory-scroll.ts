import { useLayoutEffect, useRef, type RefObject } from 'react';
import { readDirectoryState, saveDirectoryState } from './directory-state.mjs';

export function useDirectoryScroll(root: RefObject<HTMLElement | null>, repository: string, path: string, ready: boolean,
  complete = true, loadMore?: () => void) {
  const layoutReady = useRef(ready);
  const progress = useRef({ complete, loadMore });
  const restore = useRef(() => {});
  layoutReady.current = ready;
  progress.current = { complete, loadMore };
  useLayoutEffect(() => {
    const content = root.current;
    const panel = content?.closest<HTMLElement>('.main-panel');
    if (!content || !panel) return;
    let top = readDirectoryState(repository, path).scrollTop ?? 0;
    let restoring = true;
    content.toggleAttribute('data-restoring', top > 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => Boolean(content.closest('[hidden]'));
    let visible = !hidden();
    const save = () => {
      clearTimeout(timer);
      saveDirectoryState(repository, path, { scrollTop: top });
    };
    const attempt = () => {
      if (!restoring || hidden() || !layoutReady.current) return;
      if (top > panel.scrollHeight - panel.clientHeight + 1 && !progress.current.complete) {
        progress.current.loadMore?.();
        return;
      }
      panel.scrollTo({ top, behavior: 'instant' });
      restoring = false;
      top = panel.scrollTop;
      content.removeAttribute('data-restoring');
    };
    restore.current = attempt;
    const observer = new ResizeObserver(() => {
      const nextVisible = !hidden();
      if (nextVisible && !visible) {
        restoring = true;
        content.toggleAttribute('data-restoring', top > 0);
      }
      visible = nextVisible;
      attempt();
    });
    observer.observe(content);
    observer.observe(panel);
    const scrolled = () => {
      if (restoring || hidden()) return;
      top = panel.scrollTop;
      clearTimeout(timer);
      timer = setTimeout(save, 150);
    };
    // Explicit input takes priority over a pending layout restoration.
    const interact = () => {
      if (!hidden()) {
        restoring = false;
        top = panel.scrollTop;
        content.removeAttribute('data-restoring');
      }
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interact();
    };
    const visibility = () => { if (document.hidden) save(); };
    panel.addEventListener('scroll', scrolled, { passive: true });
    panel.addEventListener('wheel', interact, { passive: true });
    panel.addEventListener('touchstart', interact, { passive: true });
    panel.addEventListener('pointerdown', interact);
    panel.addEventListener('keydown', key);
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', visibility);
    attempt();
    return () => {
      save();
      content.removeAttribute('data-restoring');
      restore.current = () => {};
      observer.disconnect();
      panel.removeEventListener('scroll', scrolled);
      panel.removeEventListener('wheel', interact);
      panel.removeEventListener('touchstart', interact);
      panel.removeEventListener('pointerdown', interact);
      panel.removeEventListener('keydown', key);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [root, repository, path]);
  useLayoutEffect(() => restore.current(), [ready, complete]);
}
