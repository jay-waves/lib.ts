import React, { memo, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@primer/react';
import { createSvgCache } from './svg-cache.mjs';
import { usePageWindow } from './page-window.jsx';

const TypstPage = memo(function TypstPage({ page, index, scale, active, pageSvg, onExpired }) {
  const [image, setImage] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    setImage(null); setError('');
    if (!active) return;
    let cancelled = false, imageUrl;
    pageSvg(page.url).then(({ svg, links }) => {
      if (cancelled) return;
      imageUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      setImage({ url: imageUrl, links });
    }).catch(cause => {
      if (cancelled) return;
      if (cause.status === 410) onExpired(page.url);
      else setError(String(cause));
    });
    return () => { cancelled = true; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [active, page.url, pageSvg, onExpired]);
  return <div className="typst-page" data-page={index + 1}
    style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${900 * scale}px` }} aria-label={`Page ${index + 1}`}>
    {active && image ? <>
      <img className="typst-image" src={image.url} alt={`Page ${index + 1}`} draggable={false}
        onError={() => setError('Could not display page image')} />
      <div className="typst-links">{image.links.map((link, i) => <a key={i}
        className="typst-link" href={link.href || '#'} target={link.target} rel={link.target ? 'noopener noreferrer' : undefined}
        data-typst-page={link.page} data-typst-x={link.x} data-typst-y={link.y}
        aria-label={link.page ? `Go to page ${link.page}` : link.href}
        style={{ left: `${link.left}%`, top: `${link.top}%`, width: `${link.width}%`, height: `${link.height}%` }} />)}</div>
      {error && <div className="typst-page-status typst-page-error" role="alert">{error}</div>}
    </>
      : active && error ? <div className="typst-page-status typst-page-error" role="alert">{error}</div>
        : active ? <div className="typst-page-status"><Spinner size="small" /></div> : null}
  </div>;
});

export function TypstPages({ pages, scale, onExpired }) {
  const { ref, window } = usePageWindow(pages);
  const pageSvg = useMemo(() => createSvgCache(16, (url, options) => fetch(`${url}&format=json`, options), response => response.json()), [pages]);
  useEffect(() => () => pageSvg.clear(), [pageSvg]);
  useEffect(() => {
    // Fetch the next outer pages into the bounded cache without mounting images.
    // Errors are handled if that page becomes active, including expired revisions.
    for (const number of [window.first - 1, window.last + 1]) {
      const page = pages[number - 1];
      if (page) void pageSvg(page.url).catch(() => {});
    }
  }, [pages, pageSvg, window.first, window.last]);
  return <div ref={ref} className="typst-page-window">{pages.map((page, index) =>
    <TypstPage key={page.url} page={page} index={index} scale={scale} pageSvg={pageSvg} onExpired={onExpired}
      active={index + 1 >= window.first && index + 1 <= window.last} />)}</div>;
}
