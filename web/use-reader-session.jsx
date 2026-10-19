// Owns restoration, view/scale changes and navigation scheduling for documents.
// Keep only the latest navigation request; do not persist intermediate restoration positions.
// Tracking and resource watching remain separate from renderer layout.
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SessionActivity } from './session-activity';
import { pageBase } from './urls.mjs';
import { readingKey, readPosition, savePosition } from './reading-state.mjs';
import { readerPosition, restoreReaderPosition, navigateReaderSymbol } from './reader-position.mjs';
import { readerView, createReaderNavigation } from './reader-session.mjs';
import { symbolSelectionAt } from './active-symbol.mjs';
import { useReaderTracking } from './use-reader-tracking.jsx';
import { updateHeadingAvailability } from './markdown/preview.jsx';

export function useReaderSession({ document, root, request, view, onViewChange, onProgress }) {
  const active = useContext(SessionActivity);
  const key = readingKey(pageBase, document.path);
  const [saved] = useState(() => readPosition(key));
  const [scale, setScale] = useState(saved.scale || 1);
  const [fitRequest, setFitRequest] = useState(0);
  const latest = useRef(null), initial = useRef({ line: saved.line || 1, page: saved.page }), consumed = useRef(null), previousDocument = useRef(document);
  const selectedSymbol = useRef(null);
  const [navigation] = useState(() => createReaderNavigation(requestAnimationFrame, cancelAnimationFrame));
  latest.current = { document, view, scale, active, request, onProgress };
  const panel = () => root.current?.closest('.main-panel');
  const inset = () => (panel()?.querySelector('.file-toolbar')?.getBoundingClientRect().height || 0) + 12;
  const notify = progress => latest.current.onProgress({ ...progress, symbolId: selectedSymbol.current?.id });
  const capture = () => {
    const state = latest.current;
    if (navigation.pending || !panel()) return;
    const position = readerPosition(panel(), state.document, state.view, inset());
    if (position.line) position.line = Math.max(1, Math.min(state.document.lineCount || position.line, position.line));
    if (position.line || position.page) savePosition(key, { ...position, scale: state.scale });
    // Publish only the settled position, after restoration/initial fitting.
    // This also handles saved progress without requiring a user scroll.
    selectedSymbol.current = symbolSelectionAt(selectedSymbol.current, panel().scrollTop);
    notify({ line: position.line || null,
      page: position.page ? position.page.index + 1 : null, bookmarkPage: position.page, pending: false });
  };
  const scheduleCapture = useReaderTracking({ root, active, document, view, capture,
    retry: () => navigation.retry(), onPending: () => notify({ pending: true }),
    onScroll: top => {
      selectedSymbol.current = symbolSelectionAt(selectedSymbol.current, top);
    } });

  useLayoutEffect(() => {
    const requestedPosition = request?.path === document.path
      ? request.page ? { page: request.page } : request.line ? { line: request.line } : saved : saved;
    panel()?.classList.toggle('pathbar-hidden', !isTopPosition(requestedPosition));
  }, [key]);

  useEffect(() => {
    if (!active) return;
    const viewport = panel();
    if (!viewport) return;
    const updatePathBar = () => viewport.classList.toggle('pathbar-hidden',
      !isTopPosition(readerPosition(viewport, latest.current.document, latest.current.view, inset())));
    viewport.addEventListener('scroll', updatePathBar, { passive: true });
    return () => {
      viewport.removeEventListener('scroll', updatePathBar);
      viewport.classList.remove('pathbar-hidden');
    };
  }, [active, document.path]);

  const restore = position => {
    selectedSymbol.current = null;
    const state = latest.current;
    if (!panel() || !state.active) return false;
    if (restoreReaderPosition(panel(), state.document, state.view, position, inset()) === false) {
      navigation.retry();
      return false;
    }
    panel().classList.toggle('pathbar-hidden',
      !isTopPosition(readerPosition(panel(), state.document, state.view, inset())));
    scheduleCapture();
    return true;
  };
  const navigateSymbol = symbol => {
    if (!panel() || !latest.current.active) return false;
    const found = navigateReaderSymbol(panel(), latest.current.document, latest.current.view, symbol, inset(), updateHeadingAvailability);
    selectedSymbol.current = found ? { id: symbol.id, top: panel().scrollTop } : null;
    notify({ pending: true });
    scheduleCapture();
    // A missing outline target completes the attempt instead of indefinitely
    // suppressing position saves. Unmounted content is retried above.
    return true;
  };
  useEffect(() => {
    if (!active) { navigation.suspend(); return; }
    const documentChanged = previousDocument.current !== document;
    previousDocument.current = document;
    if (request?.path === document.path && consumed.current !== request) {
      selectedSymbol.current = null;
      consumed.current = request;
      const nextView = view;
      const position = request.page ? { page: request.page } : request.line ? { line: request.line } : initial.current;
      initial.current = null;
      navigation.request(() => {
        if (latest.current.view !== nextView) return false;
        if (request.symbol) return navigateSymbol(request.symbol);
        return position ? restore(position) : true;
      });
    } else if (initial.current) {
      const position = initial.current; initial.current = null;
      navigation.request(() => restore(position));
    } else if (documentChanged && !navigation.pending) {
      const position = readPosition(key);
      navigation.request(() => restore(position));
    } else navigation.retry();
    notify({ pending: navigation.pending });
  }, [document, request, active, view]);
  useEffect(() => () => navigation.clear(), [navigation]);

  const switchView = requested => {
    const next = readerView(document, requested);
    if (next === view) return;
    const position = panel() ? readerPosition(panel(), document, view, inset()) : {};
    // A visible PathBar is part of the document top, not a source-line anchor.
    // Preserve that native offset when the two views start on different lines.
    const headerTop = panel() && panel().scrollTop < (panel().querySelector('.page-header')?.offsetHeight || 0)
      ? panel().scrollTop : null;
    capture(); selectedSymbol.current = null;
    onViewChange(next);
    // Keep the toolbar and preview styling in sync with the reader content.
    notify({ pending: true });
    navigation.request(() => {
      if (latest.current.view !== next || !restore(position)) return false;
      if (headerTop !== null) panel().scrollTop = headerTop;
      return true;
    });
  };
  const click = event => {
    if (document.type !== 'typst' || view !== 'preview') return;
    const link = event.target.closest('a[data-typst-page]');
    if (!link) return;
    const page = Number(link.dataset.typstPage), size = document.pages[page - 1];
    if (!size) return;
    event.preventDefault(); event.stopPropagation();
    navigation.request(() => restore({ line: 1, position: { page, y: Number(link.dataset.typstY) / size.height }, behavior: 'smooth' }));
  };
  return {
    targetLine: request?.path === document.path ? request.line : null, click,
    actions: { capture, switchView, fit: () => setFitRequest(value => value + 1),
      toTop: () => panel()?.scrollTo({ top: 0, behavior: 'smooth' }) },
    viewport: {
      scale, fitRequest,
      onScale: scale => { setScale(scale); savePosition(key, { scale }); scheduleCapture(); },
    },
  };
}

function isTopPosition(position) {
  if (position.page) return position.page.index === 0 && (position.page.y ?? 0) <= 0.01;
  return (position.line ?? 1) <= 1 && !position.position;
}
