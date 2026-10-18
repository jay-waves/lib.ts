import React, { memo, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@primer/react';
import { createByteCache } from '../byte-cache.ts';
import { PDF_PAGE_WIDTH, pdfRenderWidth } from './render.ts';
import { usePageWindow } from '../page-window.jsx';
import './preview.css';

const PdfPage = memo(function PdfPage({ page, index, scale, active, cache, revision }) {
  const [image, setImage] = useState(null), [error, setError] = useState('');
  const width = pdfRenderWidth(scale, window.devicePixelRatio || 1);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);
  useEffect(() => { setImage(null); }, [page.url, revision]);
  useEffect(() => {
    setError('');
    if (!active) { setImage(null); return; }
    const controller = new AbortController();
    const url = `${page.url}&v=${encodeURIComponent(revision)}&width=${width}`;
    (async () => {
      let blob = cache.get(url);
      if (!blob) {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Page request failed (${response.status})`);
        blob = await response.blob();
        if (controller.signal.aborted) return;
        cache.set(url, blob);
      }
      if (!controller.signal.aborted) setImage(URL.createObjectURL(blob));
    })().catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, [active, page.url, revision, cache, width]);
  return <div className="pdf-page document-page" data-page={index + 1}
    style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${PDF_PAGE_WIDTH * scale}px` }} aria-label={`Page ${index + 1}`}>
    {active && image && <img src={image} alt={`Page ${index + 1}`} draggable={false}
      onError={() => setError('Could not display page image')} />}
    {active && error ? <div className="pdf-page-status pdf-page-error" role="alert">{error}</div>
      : active && !image ? <div className="pdf-page-status"><Spinner size="small" /></div> : null}
  </div>;
});

export function PdfPages({ pages, scale, modified, revision = modified }) {
  const { ref, window } = usePageWindow(pages);
  // Retain compressed blobs for short backtracking, never decoded offscreen images.
  const cache = useMemo(() => createByteCache({ maxEntries: 12, maxBytes: 16 * 1024 * 1024,
    sizeOf: blob => blob.size }), [pages, revision]);
  useEffect(() => () => cache.clear(), [cache]);
  return <div ref={ref} className="pdf-pages">{pages.map((page, index) =>
    <PdfPage key={page.url} page={page} index={index} scale={scale} revision={revision} cache={cache}
      active={index + 1 >= window.first && index + 1 <= window.last} />)}</div>;
}
