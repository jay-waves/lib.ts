import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionList, ActionMenu, BaseStyles, Breadcrumbs, IconButton, SegmentedControl, Spinner, TextInput, ThemeProvider, TreeView } from '@primer/react';
import { ArrowUpIcon, FileDirectoryIcon, FileIcon, MarkdownIcon, SearchIcon } from '@primer/octicons-react';
import { Ellipsis, PanelLeft, X } from 'lucide-react';
import DOMPurify from 'dompurify';
import { prepareMarkdown, updateAssetVersions } from './markdown.mjs';
import { hljs, highlightRaw, rawLanguage } from './raw-highlight.mjs';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '../src/markdown/theme.css';
import '../src/markdown/heading-sections.css';
import '../src/markdown/highlight.css';
import '../src/markdown/sidenotes.css';
import { observeSidenotes } from '../src/markdown/sidenote-layout.js';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
import './style.css';

hljs.registerLanguage('typst', hljs => ({
  name: 'Typst',
  aliases: ['typ'],
  contains: [
    hljs.COMMENT('//', '$'),
    { className: 'comment', begin: /\/\*/, end: /\*\//, contains: ['self'] },
    hljs.QUOTE_STRING_MODE,
    { className: 'string', begin: /`/, end: /`/ },
    { className: 'section', begin: /^={1,6}(?=\s)/, end: /$/ },
    { className: 'keyword', begin: /#(?:let|set|show|if|else|for|while|break|continue|return|import|include|as|in|and|or|not)\b/ },
    { className: 'keyword', begin: /\b(?:let|set|show|if|else|for|while|break|continue|return|import|include|as|in|and|or|not)\b/ },
    { className: 'literal', begin: /\b(?:true|false|none|auto)\b/ },
    { className: 'number', begin: /\b\d+(?:\.\d+)?(?:pt|mm|cm|in|em|fr|deg|rad|%)?\b/ },
    { className: 'symbol', begin: /@[\w-]+/ },
    { className: 'tag', begin: /<[\w:-]+>/ },
    { className: 'title.function_', begin: /[\w-]+(?=\s*\()/ },
    { className: 'meta', begin: /^\s*[-+\/](?=\s)/ },
  ],
}));

function encodePath(path) { return path.split('/').filter(Boolean).map(encodeURIComponent).join('/'); }
function noteUrl(path, directory = false) { return `/notes/${encodePath(path)}${directory && path ? '/' : ''}`; }
function currentPath() {
  try { return decodeURIComponent(location.pathname.replace(/^\/notes\/?/, '').replace(/\/$/, '')); }
  catch { return ''; }
}
function findNode(nodes, path) {
  for (const node of nodes || []) {
    if (node.path === path) return node;
    if (node.children) {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return null;
}
function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
function formatModified(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}${parts.dayPeriod}`;
}
function formatRelativeModified(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return months === 1 ? 'last month' : `${months} months ago`;
  const years = Math.floor(days / 365.25);
  return years === 1 ? 'last year' : `${years} years ago`;
}
function fileIcon(name) { return name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />; }
function filterTree(nodes, query) {
  if (!query) return nodes || [];
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return nodes || [];
  return (nodes || []).flatMap(node => {
    if (node.name.toLocaleLowerCase().includes(needle) || node.path.toLocaleLowerCase().includes(needle)) return [node];
    if (node.children) {
      const children = filterTree(node.children, needle);
      if (children.length) return [{ ...node, children }];
    }
    return [];
  });
}

function expandedPathEntries(path) {
  const entries = {};
  const parts = path.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) entries[parts.slice(0, index + 1).join('/')] = true;
  return entries;
}

function TreeNode({ node, selected, navigate, searching, expandedPaths, setExpandedPaths }) {
  const directory = node.type === 'directory';
  return (
    <TreeView.Item id={node.path} current={node.path === selected}
      expanded={directory ? (searching || Boolean(expandedPaths[node.path])) : undefined}
      onExpandedChange={directory ? expanded => setExpandedPaths(paths => ({ ...paths, [node.path]: expanded })) : undefined}
      onSelect={() => navigate(node.path, directory)}>
      <TreeView.LeadingVisual>{directory ? <TreeView.DirectoryIcon /> : fileIcon(node.name)}</TreeView.LeadingVisual>
      {node.name}
      {directory && <TreeView.SubTree>{node.children.map(child =>
        <TreeNode key={child.path} node={child} selected={selected} navigate={navigate} searching={searching}
          expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />)}</TreeView.SubTree>}
    </TreeView.Item>
  );
}

function documentLink(path) {
  const suffix = path.toLowerCase();
  return suffix.endsWith('.md') || suffix.endsWith('.typ')
    ? noteUrl(path) : `/api/asset?path=${encodeURIComponent(path)}`;
}

function Markdown({ prepared, navigate, assetVersions }) {
  const html = prepared.html;
  const contentRef = useRef(null);
  useEffect(() => observeSidenotes(contentRef.current), []);
  useEffect(() => {
    if (contentRef.current) updateHeadingAvailability(contentRef.current);
  }, [html]);
  useEffect(() => {
    updateAssetVersions(contentRef.current, assetVersions);
  }, [html, assetVersions]);
  function toggleSummary(summary) {
    const section = summary.closest('.heading-section');
    section?.classList.toggle('is-collapsed');
    if (contentRef.current) updateHeadingAvailability(contentRef.current);
  }
  function click(event) {
    const summary = event.target.closest('.heading-summary');
    if (summary && summary.getAttribute('aria-disabled') !== 'true') {
      toggleSummary(summary);
      return;
    }
    const link = event.target.closest('a[href]');
    if (link && link.origin === location.origin && link.pathname.startsWith('/notes/')) {
      event.preventDefault();
      navigate(decodeURIComponent(link.pathname.slice('/notes/'.length)));
    }
  }
  function keyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const summary = event.target.closest('.heading-summary');
    if (!summary || summary.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    toggleSummary(summary);
  }
  return <div id="content" ref={contentRef} className="rendered-markdown" onClick={click} onKeyDown={keyDown}
    dangerouslySetInnerHTML={{ __html: html }} />;
}

function updateHeadingAvailability(root) {
  root.querySelectorAll('section.heading-section').forEach(section => {
    const summary = section.querySelector(':scope > .heading-summary');
    if (!summary) return;
    const disabled = Boolean(section.parentElement?.closest('section.heading-section.is-collapsed'));
    summary.tabIndex = disabled ? -1 : 0;
    summary.setAttribute('aria-expanded', String(!section.classList.contains('is-collapsed')));
    if (disabled) summary.setAttribute('aria-disabled', 'true');
    else summary.removeAttribute('aria-disabled');
  });
}

function documentSymbols(document) {
  if (document.type === 'pdf') return (document.outline || []).map((item, index) => ({
    id: `pdf-symbol-${index}`, name: item.name, level: item.level, page: item.page,
  }));
  if (document.type === 'typst') return (document.outline || []).map((heading, index) => ({
    id: `typst-symbol-${index}`, name: heading.name, level: heading.level, line: heading.line,
  }));
  if (document.type !== 'markdown') return [];
  const dom = new DOMParser().parseFromString(document.html, 'text/html');
  return [...dom.querySelectorAll('section.heading-section > .heading-summary > :is(h1,h2,h3,h4,h5,h6)')]
    .filter(heading => heading.id).map(heading => ({
      id: heading.id, name: heading.textContent.trim(), level: Number(heading.tagName.slice(1)),
    }));
}

function RawView({ document }) {
  const source = document.source ?? document.text ?? '';
  const language = rawLanguage(document.name);
  const highlighted = useMemo(() => highlightRaw(source, document.name), [document.name, source]);
  const lines = Math.max(1, source.split('\n').length);
  return <div className="raw-view" aria-label="Source code">
    <div className="raw-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index}>{index + 1}</span>)}</div>
    <pre className="raw-code"><code className={`hljs language-${language || 'plaintext'}`}
      dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
  </div>;
}

function diagnosticExcerpt(source, range) {
  const start = Number(range?.start?.line);
  if (!Number.isInteger(start)) return '';
  const lines = String(source || '').split(/\r?\n/);
  const firstLine = Math.max(1, Math.min(lines.length, start));
  const endLine = Math.max(firstLine, Number(range?.end?.line) || firstLine);
  const from = Math.max(1, firstLine - 1);
  const to = Math.min(lines.length, endLine + 1);
  const width = String(to).length;
  return Array.from({ length: to - from + 1 }, (_, index) => {
    const line = from + index;
    return `${line === firstLine ? '>' : ' '} ${String(line).padStart(width)} │ ${lines[line - 1]}`;
  }).join('\n');
}

function LibraryError({ error, path, navigate }) {
  const detail = error instanceof Error ? error.message : String(error || 'Unknown error');
  const missing = /not found|does not exist|enoent/i.test(detail);
  const parent = path?.split('/').slice(0, -1).join('/') || '';
  return <section className="status error library-error" role="alert">
    <div>
      <h2>{missing ? 'File not found' : 'Could not load this content'}</h2>
      <p>{missing ? <>
        This file may have been moved, renamed, or deleted. <a className="error-inline-link" href={noteUrl(parent, true)}
          onClick={event => { event.preventDefault(); navigate(parent, true); }}>Return to the parent folder</a>.
      </> : 'The library could not load the requested content. The technical details are available below.'}</p>
      {path && <code className="error-path">{path}</code>}
      <details className="error-details">
        <summary>Technical details</summary>
        <pre>{detail}</pre>
      </details>
    </div>
  </section>;
}

function TypstPage({ page, index, zoom, onExpired }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '1000px 0px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    fetch(page.url).then(async response => {
      if (response.status === 410) { if (active) onExpired(page.url); return null; }
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try { detail = JSON.parse(text).error || text; } catch {}
        throw new Error(`SVG request failed (${response.status}): ${detail || response.statusText}`);
      }
      return response.text();
    }).then(value => { if (active && value) setSvg(value); })
      .catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [visible, page.url, onExpired]);

  const pageWidth = `${900 * zoom.scale}px`;
  return <div ref={ref} className="typst-page" style={{ aspectRatio: `${page.width} / ${page.height}`, width: pageWidth }}
    aria-label={`Page ${index + 1}`}>
    {svg ? <div className="typst-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      : error ? <div className="typst-page-status typst-page-error" role="alert">{error}</div>
        : <div className="typst-page-status"><Spinner size="small" /></div>}
  </div>;
}

function PdfPage({ page, index, zoom }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '1000px 0px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref} className="pdf-page" style={{ aspectRatio: `${page.width} / ${page.height}`, width: `${900 * zoom.scale}px` }}
    aria-label={`Page ${index + 1}`}>
    {visible ? <img src={page.url} alt={`Page ${index + 1}`} loading="lazy" />
      : <div className="typst-page-status"><Spinner size="small" /></div>}
  </div>;
}

function Preview({ document, prepared, navigate, previewZoom, assetVersions, onExpired }) {
  if (document.type === 'pdf') return <div className="pdf-pages">{document.pages?.map((page, index) =>
    <PdfPage key={`${page.url}:${document.modified}`} page={{ ...page, url: `${page.url}&v=${encodeURIComponent(document.modified)}` }} index={index} zoom={previewZoom} />)}</div>;
  if (document.type === 'markdown') return <Markdown prepared={prepared} navigate={navigate} assetVersions={assetVersions} />;
  if (document.type === 'typst') return (
    <div className="typst-pages">
      {document.compile?.diagnostics?.length > 0 && <section className="diagnostics" role="alert">
        <h2>Typst compilation failed</h2>
        <p className="diagnostics-summary">{document.compile.diagnostics.length} error{document.compile.diagnostics.length === 1 ? '' : 's'} prevented this document from rendering.</p>
        {document.compile.diagnostics.map((item, index) => {
          const start = item.range?.start;
          const location = `${item.file || document.path}${start?.line != null
            ? `:${start.line}${start.column != null ? `:${start.column}` : ''}` : ''}`;
          const excerpt = !item.file || item.file === document.path
            ? diagnosticExcerpt(document.source, item.range) : '';
          return <article className="diagnostic-item" key={index}>
            <div className="diagnostic-heading"><strong>{item.severity}</strong><code>{location}</code></div>
            <pre className="diagnostic-message">{item.message}</pre>
            {excerpt && <pre className="diagnostic-source">{excerpt}</pre>}
          </article>;
        })}
      </section>}
      {document.pages?.map((page, index) => <TypstPage key={page.url} page={page} index={index}
        zoom={previewZoom} onExpired={onExpired} />)}
    </div>
  );
  if (document.type === 'image') return <div className="image-preview"><img src={`${document.url}&v=${assetVersions[document.path] || 0}`} alt={document.name} /></div>;
  return <pre className="text-preview">{document.text}</pre>;
}

function App() {
  const [tree, setTree] = useState(null);
  const [selected, setSelected] = useState(currentPath);
  const [document, setDocument] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [treeRevision, setTreeRevision] = useState(0);
  const [documentRevision, setDocumentRevision] = useState(0);
  const expiredPage = useRef('');
  const onExpired = useCallback(pageUrl => {
    const id = new URL(pageUrl, location.href).searchParams.get('id');
    if (expiredPage.current === id) return;
    expiredPage.current = id;
    setDocumentRevision(value => value + 1);
  }, []);
  const [assetVersions, setAssetVersions] = useState({});
  const [search, setSearch] = useState('');
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const [fileView, setFileView] = useState('preview');
  const activeView = document?.type === 'text' ? 'raw' : fileView;
  const [filesVisible, setFilesVisible] = useState(() => !matchMedia('(max-width: 760px)').matches);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('library-sidebar-width'));
    return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 245;
  });
  const [sidebarTab, setSidebarTab] = useState('files');
  const [previewZoom, setPreviewZoom] = useState({ scale: 1 });
  const previewZoomRef = useRef(previewZoom);
  previewZoomRef.current = previewZoom;
  const [copiedAction, setCopiedAction] = useState('');
  const [copyError, setCopyError] = useState('');
  const [dark, setDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [toolbarStuck, setToolbarStuck] = useState(false);
  const toolbarRef = useRef(null);
  const mainPanelRef = useRef(null);

  function updateToolbarStuck() {
    const toolbar = toolbarRef.current;
    const panel = mainPanelRef.current;
    setToolbarStuck(Boolean(toolbar && panel && toolbar.getBoundingClientRect().top <= panel.getBoundingClientRect().top));
  }

  function resizeSidebar(event) {
    const workspace = event.currentTarget.parentElement;
    const bounds = workspace.getBoundingClientRect();
    const width = Math.max(180, Math.min(480, event.clientX - bounds.left));
    setSidebarWidth(width);
    localStorage.setItem('library-sidebar-width', String(width));
  }
  function startSidebarResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeSidebar(event);
  }

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const media = matchMedia('(max-width: 760px)');
    const update = event => setFilesVisible(!event.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { window.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => {
    const frame = requestAnimationFrame(updateToolbarStuck);
    return () => cancelAnimationFrame(frame);
  }, [document]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/tree').then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }).then(value => {
      if (!cancelled) {
        setTree(value);
      }
    }).catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [treeRevision]);
  const prepared = useMemo(() => document?.type === 'markdown'
    ? prepareMarkdown(document, documentLink) : null, [document]);
  const assetPaths = document?.path === selected ? prepared?.assets || [] : [];
  const assetPathKey = assetPaths.join('\0');
  useEffect(() => {
    if (!selected) return;
    const query = new URLSearchParams({ path: selected });
    for (const path of assetPathKey.split('\0').filter(Boolean)) query.append('asset', path);
    const stream = new EventSource(`/api/library/events?${query}`);
    stream.addEventListener('document', () => {
      setDocumentRevision(value => value + 1);
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
  }, [selected, assetPathKey]);
  useEffect(() => {
    const pop = () => {
      const path = currentPath();
      setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
      setSelected(path);
      setTreeRevision(value => value + 1);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  const selectedNode = selected ? findNode(tree?.children, selected) : null;
  const selectedNodePath = selectedNode?.path;
  const selectedNodeType = selectedNode?.type;
  useEffect(() => {
    const name = selected.split('/').filter(Boolean).at(-1) || tree?.name || 'Notes';
    window.document.title = name;
  }, [selected, tree?.name]);
  useEffect(() => {
    if (!tree) return;
    if (selected && !selectedNode) {
      setLoading(false);
      setError('File not found in the notes library');
      setDocument(null);
      return;
    }
    if (!selectedNode || selectedNode.type === 'directory') { setDocument(null); setError(''); return; }
    let cancelled = false;
    setLoading(true);
    if (document?.path !== selected) setDocument(null);
    setError('');
    fetch(`/api/document?path=${encodeURIComponent(selected)}`).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }).then(value => { if (!cancelled) setDocument(value); })
      .catch(cause => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, selectedNodePath, selectedNodeType, documentRevision]);
  useEffect(() => { setFileView('preview'); }, [selected]);
  useEffect(() => { setPreviewZoom({ scale: 1 }); }, [selected]);

  useEffect(() => {
    if (!['typst', 'pdf'].includes(document?.type) || fileView !== 'preview') return;
    const change = direction => setPreviewZoom(current => ({
      scale: Math.min(2.5, Math.max(.35, current.scale + direction * .1)),
    }));
    const onWheel = event => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const factor = Math.exp(-event.deltaY * unit * .001);
      setPreviewZoom(current => ({ scale: Math.min(2.5, Math.max(.35, current.scale * factor)) }));
    };
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key;
      const direction = key === '+' || key === '=' || key === 'Add' ? 1
        : key === '-' || key === '_' || key === 'Subtract' ? -1 : 0;
      if (direction) {
        event.preventDefault();
        event.stopPropagation();
        change(direction);
      } else if (key === '0' || key === 'Numpad0') {
        event.preventDefault();
        event.stopPropagation();
        setPreviewZoom({ scale: 1 });
      }
    };
    let pinchStart = null;
    const touchDistance = touches => Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY,
    );
    const onTouchStart = event => {
      if (event.touches.length < 2 || !event.target.closest?.('.typst-pages, .pdf-pages')) return;
      pinchStart = { distance: touchDistance(event.touches), scale: previewZoomRef.current.scale };
      event.preventDefault();
    };
    const onTouchMove = event => {
      if (!pinchStart || event.touches.length < 2) return;
      event.preventDefault();
      const scale = pinchStart.scale * Math.pow(
        touchDistance(event.touches) / Math.max(1, pinchStart.distance), .65,
      );
      setPreviewZoom({ scale: Math.min(2.5, Math.max(.35, scale)) });
    };
    const onTouchEnd = event => { if (event.touches.length < 2) pinchStart = null; };
    window.document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.document.addEventListener('keydown', onKeyDown, { capture: true });
    window.document.addEventListener('touchstart', onTouchStart, { passive: false, capture: true });
    window.document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    window.document.addEventListener('touchend', onTouchEnd, { capture: true });
    window.document.addEventListener('touchcancel', onTouchEnd, { capture: true });
    return () => {
      window.document.removeEventListener('wheel', onWheel, true);
      window.document.removeEventListener('keydown', onKeyDown, true);
      window.document.removeEventListener('touchstart', onTouchStart, true);
      window.document.removeEventListener('touchmove', onTouchMove, true);
      window.document.removeEventListener('touchend', onTouchEnd, true);
      window.document.removeEventListener('touchcancel', onTouchEnd, true);
    };
  }, [document?.type, fileView]);

  function navigate(path, directory = false) {
    history.pushState(null, '', noteUrl(path, directory));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    setTreeRevision(value => value + 1);
    if (matchMedia('(max-width: 760px)').matches) setFilesVisible(false);
    if (directory) setSidebarTab('files');
  }
  const parts = selected.split('/').filter(Boolean);
  const entries = selectedNode?.type === 'directory' ? selectedNode.children : !selected ? tree?.children : null;
  const filteredTree = useMemo(() => filterTree(tree?.children, search), [tree, search]);
  const symbols = useMemo(() => document ? documentSymbols(document) : [], [document]);

  function jumpToSymbol(symbol) {
    if (matchMedia('(max-width: 760px)').matches) setFilesVisible(false);
    if (document.type === 'markdown') {
      window.document.getElementById(symbol.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (document.type === 'pdf') {
      window.document.querySelectorAll('.pdf-page')[symbol.page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const pages = [...window.document.querySelectorAll('.typst-page')];
    if (!pages.length || !symbol.line) return;
    const index = Math.min(pages.length - 1, Math.floor((symbol.line - 1) / Math.max(1, document.lineCount) * pages.length));
    pages[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function copyValue(label, value) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAction(label);
      window.setTimeout(() => setCopiedAction(''), 1400);
      setCopyError('');
    } catch (cause) {
      setCopyError(`Could not copy ${label.toLowerCase()}: ${cause.message || cause}`);
    }
  }
  return <ThemeProvider colorMode={dark ? 'night' : 'day'}><BaseStyles>
    <div className={`app-shell ${filesVisible ? '' : 'files-hidden'}`}>
      <div className="workspace" style={{ '--sidebar-width': `${sidebarWidth}px` }}>
        <aside className="sidebar" aria-label={sidebarTab === 'files' ? 'Files' : 'Symbols'}>
          <div className="sidebar-title">
            <div className="sidebar-segmented-control">
              <SegmentedControl aria-label="Sidebar view" className="sidebar-view-control" size="small" fullWidth
                onChange={index => { setSidebarTab(index === 0 ? 'files' : 'symbols'); setFilesVisible(true); }}>
                <SegmentedControl.Button selected={sidebarTab === 'files'}>Files</SegmentedControl.Button>
                <SegmentedControl.Button selected={sidebarTab === 'symbols'}>Symbols</SegmentedControl.Button>
              </SegmentedControl>
            </div>
            <IconButton size="small" variant="invisible" className="sidebar-close" icon={X}
              aria-label="Close sidebar" title="Close sidebar" onClick={() => setFilesVisible(false)} />
          </div>
          {sidebarTab === 'files' ? <><div className="file-search">
            <TextInput aria-label="Search files" placeholder="Go to file" leadingVisual={SearchIcon}
              value={search} onChange={event => setSearch(event.target.value)} />
          </div>
          <div className="tree-scroll">{tree ? filteredTree.length ? <TreeView aria-label="Notes tree">
            {filteredTree.map(node => <TreeNode key={node.path} node={node} selected={selected} navigate={navigate}
              searching={Boolean(search.trim())} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />)}
          </TreeView> : <div className="tree-empty">No matching files</div> : <div className="tree-loading"><Spinner size="small" /></div>}</div>
          </> : <nav className="symbols-list tree-scroll" aria-label="Document symbols">{symbols.length ?
            <ActionList variant="full">{symbols.map(symbol => <ActionList.Item key={symbol.id}
              style={{ marginInlineStart: `${Math.max(0, (symbol.level || 1) - 1) * 20}px` }}
              onSelect={() => jumpToSymbol(symbol)}><span className="symbol-name">{symbol.name}</span></ActionList.Item>)}</ActionList>
            : <div className="tree-empty">No symbols found</div>}</nav>}
        </aside>
        <div className="sidebar-resize" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
          aria-valuemin={180} aria-valuemax={480} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0}
          onPointerDown={startSidebarResize} onPointerMove={event => { if (event.buttons === 1) resizeSidebar(event); }}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const width = Math.max(180, Math.min(480, sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10)));
            setSidebarWidth(width);
            localStorage.setItem('library-sidebar-width', String(width));
          }} />
        <main className="main-panel" ref={mainPanelRef} onScroll={updateToolbarStuck}>
          <div className="page-header">
            <div className="path-row">
              <Breadcrumbs>
                <Breadcrumbs.Item href="/" onClick={event => { event.preventDefault(); navigate(''); }}>{tree?.name || 'Notes'}</Breadcrumbs.Item>
                {parts.map((part, index) => <Breadcrumbs.Item key={index} href={noteUrl(parts.slice(0, index + 1).join('/'))}
                  selected={index === parts.length - 1} onClick={event => { event.preventDefault(); navigate(parts.slice(0, index + 1).join('/')); }}>
                  {part}</Breadcrumbs.Item>)}
              </Breadcrumbs>
              <div className="path-actions">
                {document && <div className="file-meta">
                  {document.lineCount != null && <span>{document.lineCount} lines</span>}
                  <span>{sizeLabel(document.size)}</span>
                  {document.modified && <time className="file-modified" dateTime={document.modified} title={formatModified(document.modified)}>
                    {formatRelativeModified(document.modified)}
                  </time>}
                </div>}
                {document && <ActionMenu>
                  <ActionMenu.Anchor>
                    <IconButton size="small" variant="invisible" className="path-actions-button" icon={Ellipsis}
                      aria-label="Menu" title="Menu" />
                  </ActionMenu.Anchor>
                  <ActionMenu.Overlay>
                    <ActionList>
                      <ActionList.Item onSelect={() => copyValue('raw file link', `${location.origin}/api/asset?path=${encodeURIComponent(document.path)}`)}>
                        Copy raw file{copiedAction === 'raw file link' ? ' · Copied' : ''}
                      </ActionList.Item>
                      <ActionList.Item onSelect={() => copyValue('path', document.path)}>
                        Copy path{copiedAction === 'path' ? ' · Copied' : ''}
                      </ActionList.Item>
                      <ActionList.Item onSelect={() => copyValue('absolute path', document.absolutePath)}>
                        Copy absolute path{copiedAction === 'absolute path' ? ' · Copied' : ''}
                      </ActionList.Item>
                    </ActionList>
                  </ActionMenu.Overlay>
                </ActionMenu>}
              </div>
            </div>
          </div>
          <div className="content-panel">
            {copyError && <div className="action-error" role="alert">{copyError}</div>}
            {loading && !document && <div className="status"><Spinner /> Rendering…</div>}
            {!loading && error && <LibraryError error={error} path={selected} navigate={navigate} />}
            {!loading && !error && entries && <div className="directory-list">
              <div className="directory-heading">{entries.length} items</div>
              {entries.map(node => <a key={node.path} href={noteUrl(node.path, node.type === 'directory')}
                onClick={event => { event.preventDefault(); navigate(node.path, node.type === 'directory'); }}>
                {node.type === 'directory' ? <FileDirectoryIcon /> : fileIcon(node.name)}<span>{node.name}</span>
                {node.type === 'directory' && node.modified && <time className="directory-modified" dateTime={node.modified}
                  title={formatModified(node.modified)}>{formatRelativeModified(node.modified)}</time>}
              </a>)}
            </div>}
            {!error && document && <>
              <div className="file-toolbar" ref={toolbarRef}>
                <div className="file-tabs" role="tablist" aria-label="File view">
                  {document.type !== 'text' && <button className={`file-tab ${activeView === 'preview' ? 'selected' : ''}`} role="tab"
                    aria-selected={activeView === 'preview'} onClick={() => setFileView('preview')}>Preview</button>}
                  {document.type !== 'image' && document.type !== 'pdf' && <button className={`file-tab ${activeView === 'raw' ? 'selected' : ''}`} role="tab"
                    aria-selected={activeView === 'raw'} onClick={() => setFileView('raw')}>Raw</button>}
                </div>
                <div className="toolbar-actions" role="group" aria-label="Page actions">
                  {toolbarStuck && <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
                    title="Back to top" onClick={() => mainPanelRef.current?.scrollTo({ top: 0, behavior: 'smooth' })} />}
                  <IconButton size="small" variant="invisible" className="sidebar-toggle" icon={PanelLeft}
                    aria-label="Toggle sidebar" title="Toggle sidebar" aria-pressed={filesVisible}
                    onClick={() => setFilesVisible(value => !value)} />
                </div>
              </div>
              {activeView === 'raw' && document.type !== 'image' ? <RawView document={document} />
                : <Preview document={document} prepared={prepared} navigate={navigate} previewZoom={previewZoom}
                  assetVersions={assetVersions} onExpired={onExpired} />}
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles></ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
