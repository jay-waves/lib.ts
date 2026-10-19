import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bindViewportGestures, clampScale, fitDocumentPage } from './document-viewport.mjs';
import { pagePosition, restorePagePosition } from './reading-state.mjs';
import { SessionActivity } from './session-activity';
import { usePreview } from './preview-context.jsx';

export function useDocumentViewport(layout) {
  const { viewport: { scale, onScale, fitRequest } } = usePreview();
  const { pageCount, initialFit } = layout;
  const ref = useRef(null), canvas = useRef(null), pending = useRef(null), current = useRef(null);
  const attach = useCallback(element => {
    canvas.current = element;
    ref.current = element?.closest('.main-panel') || null;
  }, []);
  const active = useContext(SessionActivity);
  const initiallyFitted = useRef(false);
  const lastFitRequest = useRef(fitRequest);
  const [revision, setRevision] = useState(0);
  current.current = { scale, onScale };
  const zoom = (next, point, previousPoint = point) => {
    const viewport = ref.current;
    const rect = viewport.getBoundingClientRect();
    point ||= { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 };
    previousPoint ||= point;
    // Preserve the original document coordinate across coalesced input events.
    const saved = pending.current?.saved || pagePosition(viewport, previousPoint.x, previousPoint.y);
    pending.current = { saved, ...point };
    current.current.scale = clampScale(next);
    current.current.onScale(current.current.scale);
    setRevision(value => value + 1);
  };
  const fitAndRecenter = useCallback((fitPage = fitDocumentPage, preserveTop = false) => {
    const viewport = ref.current;
    if (!viewport?.clientWidth || !viewport.clientHeight) return false;
    const bounds = viewport.getBoundingClientRect();
    const x = bounds.left + viewport.clientLeft + viewport.clientWidth / 2;
    const saved = pagePosition(viewport, x, bounds.top + viewport.clientHeight / 2);
    const page = viewport.querySelectorAll('.document-page[data-page]')[saved?.index];
    if (!page) return false;
    const rect = page.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const width = rect.width / current.current.scale;
    const toolbar = viewport.querySelector('.file-toolbar');
    const toolbarHeight = toolbar?.getBoundingClientRect().height || 0;
    const pathBarHeight = viewport.querySelector('.page-header')?.offsetHeight || 0;
    const headerTop = preserveTop && viewport.scrollTop < pathBarHeight ? viewport.scrollTop : null;
    const headerHeight = headerTop !== null ? pathBarHeight - headerTop : 0;
    const availableHeight = viewport.clientHeight - toolbarHeight - headerHeight;
    const fit = fitPage(width, rect.height / current.current.scale, toolbar?.clientWidth || viewport.clientWidth, availableHeight);
    const height = rect.height / current.current.scale * fit.scale;
    pending.current = { saved: { index: saved.index, x: .5, y: 0 }, x, headerTop,
      y: bounds.top + viewport.clientTop + toolbarHeight + headerHeight
        + (fit.mode === 'page' ? Math.max(24, (availableHeight - height) / 2) : 24) };
    current.current.scale = fit.scale;
    current.current.onScale(fit.scale);
    setRevision(value => value + 1);
    initiallyFitted.current = true;
    return true;
  }, []);
  useEffect(() => {
    if (fitRequest === lastFitRequest.current) return;
    lastFitRequest.current = fitRequest;
    fitAndRecenter();
  }, [fitRequest, fitAndRecenter]);
  useEffect(() => {
    if (!active || !pageCount || initiallyFitted.current) return;
    // Let the parent's reading-position restoration finish before choosing a page.
    // Page placeholders already have dimensions; image loading is irrelevant.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!initiallyFitted.current) fitAndRecenter(initialFit, true);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialFit, active, pageCount, fitAndRecenter]);
  useLayoutEffect(() => {
    const viewport = canvas.current;
    // Only the canvas expands; the page frame and toolbar retain their width.
    viewport.style.setProperty('--document-width', `${layout.contentWidth * scale + 48}px`);
    return () => viewport.style.removeProperty('--document-width');
  }, [layout.contentWidth, scale]);
  useLayoutEffect(() => {
    // Images only acquire dimensions on load. Fit that first measured layout
    // before painting rather than displaying the native-size image for two frames.
    if (layout.fitBeforePaint && active && pageCount && !initiallyFitted.current) {
      fitAndRecenter(initialFit, true);
    }
  }, [layout.fitBeforePaint, active, pageCount, initialFit, fitAndRecenter]);
  useLayoutEffect(() => {
    const point = pending.current;
    if (point?.saved) restorePagePosition(ref.current, point.saved, point.x, point.y);
    if (point?.headerTop != null) ref.current.scrollTop = point.headerTop;
    pending.current = null;
  }, [scale, revision]);
  useEffect(() => bindViewportGestures(ref.current, {
    zoom, getScale: () => current.current.scale, horizontalViewport: canvas.current,
    isEnabled: () => ref.current?.classList.contains('document-viewport'),
  }), []);
  return { ref: attach, scale };
}
