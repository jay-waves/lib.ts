import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { bindViewportGestures, clampScale, fitDocumentPage } from './document-viewport.mjs';
import { pagePosition, restorePagePosition } from './reading-state.mjs';
import { SessionActivity } from './session-activity.jsx';
import './document-viewport.css';

export function DocumentViewport({ scale, onScale, onScroll, onNavigate, fitRequest, pageCount, children }) {
  const ref = useRef(null), pending = useRef(null), current = useRef(null);
  const active = useContext(SessionActivity);
  const initiallyFitted = useRef(false);
  const lastFitRequest = useRef(fitRequest);
  const [revision, setRevision] = useState(0);
  current.current = { scale, onScale, onNavigate };
  const zoom = (next, point, previousPoint = point) => {
    const viewport = ref.current;
    const rect = viewport.getBoundingClientRect();
    point ||= { x: rect.left + viewport.clientWidth / 2, y: rect.top + viewport.clientHeight / 2 };
    previousPoint ||= point;
    // Preserve the original document coordinate across coalesced input events.
    const saved = pending.current?.saved || pagePosition(viewport, previousPoint.x, previousPoint.y);
    pending.current = { saved, ...point };
    current.current.scale = clampScale(next);
    current.current.onScale({ scale: current.current.scale });
    setRevision(value => value + 1);
  };
  const fitAndRecenter = useCallback(() => {
    const viewport = ref.current;
    if (!viewport?.clientWidth || !viewport.clientHeight) return false;
    const bounds = viewport.getBoundingClientRect();
    const x = bounds.left + viewport.clientLeft + viewport.clientWidth / 2;
    const saved = pagePosition(viewport, x, bounds.top + viewport.clientHeight / 2);
    const page = viewport.querySelectorAll('div.typst-page[data-page], .pdf-page')[saved?.index];
    if (!page) return false;
    const rect = page.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const fit = fitDocumentPage(rect.width / current.current.scale, rect.height / current.current.scale,
      viewport.clientWidth, viewport.clientHeight);
    const height = rect.height / current.current.scale * fit.scale;
    pending.current = { saved: { index: saved.index, x: .5, y: 0 }, x,
      y: bounds.top + viewport.clientTop + (fit.mode === 'page' ? Math.max(24, (viewport.clientHeight - height) / 2) : 24) };
    current.current.scale = fit.scale;
    current.current.onScale({ scale: fit.scale });
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
        if (!initiallyFitted.current) fitAndRecenter();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, pageCount, fitAndRecenter]);
  useLayoutEffect(() => {
    const point = pending.current;
    if (point?.saved) restorePagePosition(ref.current, point.saved, point.x, point.y);
    pending.current = null;
  }, [scale, revision]);
  useEffect(() => bindViewportGestures(ref.current, {
    zoom, getScale: () => current.current.scale,
    onNavigate: delta => current.current.onNavigate?.(delta),
  }), []);
  return <div className="document-viewer">
    <div ref={ref} className="document-viewport" tabIndex={0}
      role="region" aria-label="Document preview" onScroll={onScroll}>
      <div className="document-stage" style={{ width: `max(100%, ${900 * scale + 48}px)` }}>{children}</div>
    </div>
  </div>;
}
