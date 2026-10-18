import { SessionActivity } from './session-activity';
import { useContext, useEffect, useRef, useState } from 'react';
import { observePageWindow } from './page-window.mjs';

export function usePageWindow(pages) {
  const active = useContext(SessionActivity);
  const ref = useRef(null);
  // Visibility pauses observation, not the retained page window. Renderers keep
  // these pages mounted until scrolling or a document revision replaces them.
  const [window, setWindow] = useState({ first: 1, last: Math.min(3, pages.length) });
  const previousPages = useRef(pages);
  const current = useRef(window);
  current.current = window;
  useEffect(() => {
    const initial = previousPages.current === pages ? current.current : { first: 1, last: Math.min(3, pages.length) };
    previousPages.current = pages;
    if (active) return observePageWindow(ref.current, pages.length, setWindow, globalThis.IntersectionObserver, initial);
    current.current = initial;
  }, [pages, active]);
  return { ref, window };
}
