import { useEffect, useRef } from 'react';
import { flushReadingPositions } from './reading-state.mjs';
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
    const changed = event => {
      if (event?.type === 'scroll' && event.target === panel) latest.current.onScroll(panel.scrollTop);
      latest.current.retry(); schedule();
    };
    const observer = new ResizeObserver(changed);
    observer.observe(panel);
    for (const content of root.current.querySelectorAll('.rendered-markdown, .raw-view, .document-page')) observer.observe(content);
    panel.addEventListener('scroll', changed, true);
    panel.addEventListener('load', changed, true);
    panel.addEventListener('error', changed, true);
    const frame = requestAnimationFrame(changed);
    const stopSmoothWheel = view === 'raw' || !panel.matches('.document-viewport') ? enableSmoothWheel(panel) : undefined;
    return () => {
      cancelAnimationFrame(frame); clearTimeout(timer.current);
      timer.current = null;
      observer.disconnect(); panel.removeEventListener('scroll', changed, true);
      panel.removeEventListener('load', changed, true);
      panel.removeEventListener('error', changed, true);
      stopSmoothWheel?.();
    };
  }, [active, document, view, root]);
  useEffect(() => {
    const captureNow = () => {
      clearTimeout(timer.current); timer.current = null;
      latest.current.capture();
    };
    const exit = () => { captureNow(); flushReadingPositions(); };
    const hidden = () => { if (window.document.hidden) exit(); };
    addEventListener('reading-capture', captureNow);
    addEventListener('pagehide', exit);
    window.document.addEventListener('visibilitychange', hidden);
    return () => {
      captureNow(); flushReadingPositions();
      removeEventListener('reading-capture', captureNow); removeEventListener('pagehide', exit);
      window.document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  return schedule;
}
