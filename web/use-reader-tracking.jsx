import { useEffect, useRef } from 'react';
import { syncReadingPositions } from './reading-state.mjs';
import { enableSmoothWheel } from './smooth-scroll.mjs';

export function useReaderTracking({ root, active, document, view, capture, retry, onPending, onScroll }) {
  const latest = useRef(null), timer = useRef(null);
  latest.current = { capture, retry, onPending, onScroll };
  const schedule = () => {
    if (timer.current === null) latest.current.onPending();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current.capture();
    }, 150);
  };
  useEffect(() => {
    if (!active) return;
    const panel = root.current?.closest('.main-panel');
    if (!panel) return;
    const viewport = panel.querySelector('.document-viewport') || panel;
    const changed = event => {
      if (event?.type === 'scroll' && event.target === viewport) latest.current.onScroll(viewport.scrollTop);
      latest.current.retry(); schedule();
    };
    const observer = new ResizeObserver(changed);
    observer.observe(panel);
    for (const content of root.current.querySelectorAll('.rendered-markdown, .raw-view, .document-page')) observer.observe(content);
    panel.addEventListener('scroll', changed, true);
    const frame = requestAnimationFrame(changed);
    const stopSmoothWheel = viewport === panel ? enableSmoothWheel(panel) : undefined;
    return () => {
      cancelAnimationFrame(frame); clearTimeout(timer.current);
      timer.current = null;
      observer.disconnect(); panel.removeEventListener('scroll', changed, true);
      stopSmoothWheel?.();
    };
  }, [active, document, view, root]);
  useEffect(() => {
    const captureNow = () => {
      clearTimeout(timer.current); timer.current = null;
      latest.current.capture();
    };
    const exit = () => { captureNow(); syncReadingPositions(true).catch(() => {}); };
    const hidden = () => { if (window.document.hidden) exit(); };
    addEventListener('reading-capture', captureNow);
    addEventListener('pagehide', exit);
    window.document.addEventListener('visibilitychange', hidden);
    return () => {
      captureNow();
      removeEventListener('reading-capture', captureNow); removeEventListener('pagehide', exit);
      window.document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  return schedule;
}
