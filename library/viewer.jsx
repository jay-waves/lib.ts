import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DOMPurify from 'dompurify';
import { prepareMarkdown, updateAssetVersions } from './markdown.mjs';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '../src/markdown/theme.css';
import '../src/markdown/highlight.css';
import '../src/markdown/sidenotes.css';
import { observeSidenotes } from '../src/markdown/sidenote-layout.js';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
import './style.css';

const query = new URLSearchParams(location.search);
const selected = query.get('path') || '';
function hrefFor(path) { return `/?path=${encodeURIComponent(path)}`; }
function Markdown({ prepared, assetVersions }) {
  const contentRef = useRef(null);
  useEffect(() => observeSidenotes(contentRef.current), []);
  const html = prepared.html;
  useEffect(() => {
    updateAssetVersions(contentRef.current, assetVersions);
  }, [html, assetVersions]);
  return <main ref={contentRef} className="simple-document rendered-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
function Typst({ document, onExpired }) {
  const [pages, setPages] = useState([]);
  useEffect(() => {
    let cancelled = false;
    Promise.all((document.pages || []).map(async page => {
      const response = await fetch(page.url, { cache: 'no-store' });
      if (response.status === 410) { if (!cancelled) onExpired(page.url); return null; }
      if (!response.ok) throw new Error(`SVG 请求失败 (${response.status})`);
      return { ...page, svg: DOMPurify.sanitize(await response.text(), { USE_PROFILES: { svg: true, svgFilters: true }, ADD_ATTR: ['class', 'transform', 'viewBox', 'preserveAspectRatio'] }) };
    })).then(value => { if (!cancelled && value.every(Boolean)) setPages(value); }).catch(error => {
      if (!cancelled) setPages([{ error: String(error) }]);
    });
    return () => { cancelled = true; };
  }, [document, onExpired]);
  return <main className="simple-typst">{pages.length ? pages.map((page, i) => page.error
    ? <p key={i} className="simple-error">{page.error}</p>
    : <section key={i} className="simple-page" style={{ aspectRatio: `${page.width} / ${page.height}` }} dangerouslySetInnerHTML={{ __html: page.svg }} />)
    : <p>正在加载 SVG…</p>}</main>;
}
function App() {
  const [document, setDocument] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const expiredPage = useRef('');
  const onExpired = useCallback(pageUrl => {
    const id = new URL(pageUrl, location.href).searchParams.get('id');
    if (expiredPage.current === id) return;
    expiredPage.current = id;
    setRevision(value => value + 1);
  }, []);
  const [assetVersions, setAssetVersions] = useState({});
  const prepared = useMemo(() => document?.type === 'markdown'
    ? prepareMarkdown(document, hrefFor) : null, [document]);
  const assetPaths = prepared?.assets || [];
  const assetPathKey = assetPaths.join('\0');
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/document?path=${encodeURIComponent(selected)}`, { cache: 'no-store' })
      .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value; })
      .then(value => { if (!cancelled) { setDocument(value); setError(''); } })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [revision]);
  useEffect(() => {
    if (!selected) return;
    const query = new URLSearchParams({ path: selected });
    for (const path of assetPathKey.split('\0').filter(Boolean)) query.append('asset', path);
    const stream = new EventSource(`/api/library/events?${query}`);
    stream.addEventListener('document', () => {
      setRevision(value => value + 1);
      setAssetVersions(versions => ({ ...versions, [selected]: Date.now() }));
    });
    stream.addEventListener('assets', event => {
      const paths = JSON.parse(event.data).paths || [];
      setAssetVersions(versions => {
        const next = { ...versions };
        for (const path of paths) next[path] = Date.now();
        return next;
      });
    });
    return () => stream.close();
  }, [assetPathKey]);
  useEffect(() => {
    window.document.title = document?.name || selected.split('/').filter(Boolean).at(-1) || 'Document Preview';
  }, [document?.name]);
  return <div className="simple-shell">{error ? <p className="simple-error">{error}</p> : !document ? <p>正在加载…</p>
    : document.type === 'markdown' ? <Markdown prepared={prepared} assetVersions={assetVersions} />
      : document.type === 'typst' ? <><header>{document.compile?.diagnostics?.map((item, i) => <p key={i} className="simple-error">{item.severity}: {item.message}</p>)}</header><Typst document={document} onExpired={onExpired} /></>
        : document.type === 'image' ? <img className="simple-image" src={`${document.url}&v=${assetVersions[document.path] || 0}`} alt={document.name} />
          : <pre className="simple-text">{document.text}</pre>}</div>;
}
createRoot(document.getElementById('root')).render(<App />);
