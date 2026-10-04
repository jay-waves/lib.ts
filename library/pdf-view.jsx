import React, { memo, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@primer/react';
import { createByteCache } from './byte-cache.mjs';
import { usePageWindow } from './page-window.jsx';

const PdfPage = memo(function PdfPage({ page, index, scale, active, cache, modified }) {
  const [image, setImage] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    setImage(null); setError('');
    if (!active) return;
    const controller = new AbortController();
    let imageUrl;
    const url = `${page.url}&v=${encodeURIComponent(modified)}`;
    (async () => {
      let blob = cache.get(url);
      if (!blob) {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Page request failed (${response.status})`);
        blob = await response.blob();
        if (controller.signal.aborted) return;
        cache.set(url, blob);
      }
      imageUrl = URL.createObjectURL(blob);
      setImage(imageUrl);
    })().catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => { controller.abort(); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [active, page.url, modified, cache]);
  return <div className="pdf-page" data-page={index + 1}
    style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${900 * scale}px` }} aria-label={`Page ${index + 1}`}>
    {active && image && <img src={image} alt={`Page ${index + 1}`} draggable={false}
      onError={() => setError('Could not display page image')} />}
    {active && error ? <div className="typst-page-status typst-page-error" role="alert">{error}</div>
      : active && !image ? <div className="typst-page-status"><Spinner size="small" /></div> : null}
  </div>;
});

export function PdfPages({ pages, scale, modified }) {
  const { ref, window } = usePageWindow(pages);
  // Retain compressed blobs for short backtracking, never decoded offscreen images.
  const cache = useMemo(() => createByteCache({ maxEntries: 12, maxBytes: 16 * 1024 * 1024,
    sizeOf: blob => blob.size }), [pages, modified]);
  useEffect(() => () => cache.clear(), [cache]);
  return <div ref={ref} className="pdf-pages">{pages.map((page, index) =>
    <PdfPage key={page.url} page={page} index={index} scale={scale} modified={modified} cache={cache}
      active={index + 1 >= window.first && index + 1 <= window.last} />)}</div>;
}
