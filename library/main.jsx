import { useDocumentLease } from './document-session.jsx';
import { BrowserSession, SessionActivity } from './session-activity.jsx';
import { formatRelativeModified, HISTORY_GROUPS } from './time-labels.mjs';
import { visibleEvents } from './visible-events.mjs';
import { parseDocumentOpenEvent } from './session-events.mjs';
import { observeMarkdownPosition } from './markdown-position.mjs';
import { sortFileTree, fileTreeForView, isPlainTreeActivation, indexFileTree } from './file-tree.mjs';
import { useFileTree } from './use-file-tree.jsx';
import { apiBase, pageBase, treeBase, repoId, routeKind, fileUrl } from './urls.mjs';
import { searchUrl, gitUrl, parseRepositoryLocation } from './paths.mjs';
import React, { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import morphdom from 'morphdom';
import { createRoot } from 'react-dom/client';
import { ActionList, ActionMenu, BaseStyles, Breadcrumbs, Dialog, IconButton, Spinner, ThemeProvider, TreeView, Tooltip } from '@primer/react';
import { SearchInput } from './search-input.jsx';
import { PinIcon, XIcon, CopyIcon, FileDirectoryOpenFillIcon, FocusCenterIcon, SortDescIcon, FoldIcon, ArrowUpIcon, FileDirectoryIcon, FileIcon, MarkdownIcon, SearchIcon, KebabHorizontalIcon, SidebarExpandIcon, ListUnorderedIcon, RepoIcon, GitBranchIcon, BookmarkIcon, HistoryIcon } from '@primer/octicons-react';
import { BookmarkMenu, useBookmarks } from './bookmarks.jsx';
import { RecentFiles, useRecentFiles } from './recent-files.jsx';
import { RepoPicker } from './repo-picker.jsx';
import { useWorkspaceSearch } from './workspace-search.jsx';
import { useGitStatus } from './use-git-status.jsx';
import { readSidebarState, saveSidebarState } from './sidebar-state.mjs';
import { prepareMarkdown, updateAssetVersions } from './markdown.mjs';
import { hljs, highlightRaw, rawLanguage } from './raw-highlight.mjs';
import { sourceLineAtViewport, scrollToTypstSource } from './typst-navigation.mjs';
import { DocumentViewport } from './document-viewport.jsx';
import { TypstPages } from './typst-view.jsx';
import { PdfPages } from './pdf-view.jsx';
import { readingKey, readPosition, loadPosition, syncReadingPositions, savePosition, pagePosition, restorePagePosition } from './reading-state.mjs';
import { enableSmoothWheel } from './smooth-scroll.mjs';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/base/motion/motion.css';
import '../src/markdown/theme.css';
import '../src/markdown/heading-sections.css';
import '../src/markdown/highlight.css';
import '../src/markdown/sidenotes.css';
import { observeSidenotes } from '../src/markdown/sidenote-layout.js';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
import './style.css';
import './sidebar.css';

const GitPanel = lazy(() => import('./git-panel.jsx'));
const GitDiffView = lazy(() => import('./git-diff-view.jsx'));

const sidebarViews = [
  { id: 'files', label: 'Files', icon: FileDirectoryIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'symbols', label: 'Symbols', icon: ListUnorderedIcon },
  { id: 'bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
  { id: 'git', label: 'Git', icon: GitBranchIcon },
  { id: 'repos', label: 'Repos', icon: RepoIcon },
];

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

function noteUrl(path, directory = false) { return fileUrl(path, directory); }
function currentRouteKind() { return parseRepositoryLocation(location.pathname)?.kind || null; }
function currentPath() {
  const route = parseRepositoryLocation(location.pathname);
  return route?.kind === 'tree' ? route.path : route?.kind === 'search' ? new URLSearchParams(location.search).get('file') || '' : '';
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

function fileIcon(name) { return name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />; }

function expandedPathEntries(path) {
  const entries = {};
  const parts = path.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) entries[parts.slice(0, index + 1).join('/')] = true;
  return entries;
}

function TreeNode({ node, selected, navigate, searching, expandedPaths, setExpandedPaths, bookmarkState, defaultExpanded = false }) {
  const directory = node.type === 'directory';
  return (
    <TreeView.Item id={node.path} current={node.path === selected}
      secondaryActions={!directory && bookmarkState ? [{
        label: bookmarkState.bookmarks.some(item => item.path === node.path) ? 'Remove bookmark' : 'Add bookmark',
        icon: bookmarkState.bookmarks.some(item => item.path === node.path) ? XIcon : PinIcon,
        onClick: () => { if (!bookmarkState.loading && !bookmarkState.saving) void bookmarkState.setBookmark(node.path,
          !bookmarkState.bookmarks.some(item => item.path === node.path)); },
      }] : undefined}
      expanded={directory ? (node.virtual ? expandedPaths[node.path] ?? true : searching || (expandedPaths[node.path] ?? defaultExpanded)) : undefined}
      onExpandedChange={directory ? expanded => setExpandedPaths(paths => ({ ...paths, [node.path]: expanded })) : undefined}
      onSelect={event => {
        if (!isPlainTreeActivation(event)) return;
        event.preventDefault();
        if (node.virtual) {
          setExpandedPaths(paths => ({ ...paths, [node.path]: !(paths[node.path] ?? true) }));
          return;
        }
        navigate(node.path, directory);
      }}>
      <TreeView.LeadingVisual>{directory ? <TreeView.DirectoryIcon /> : fileIcon(node.name)}</TreeView.LeadingVisual>
      {node.virtual ? <span className="file-tree-link">{node.name}</span> : !directory ? <Tooltip className="file-path-tooltip" text={node.path} direction="s"
        onContextMenu={event => event.currentTarget.classList.add('is-context-menu-open')}
        onMouseLeave={event => event.currentTarget.classList.remove('is-context-menu-open')}>
        <a className="file-tree-link" href={noteUrl(node.path)} tabIndex={-1}>{node.name}</a>
      </Tooltip> : <a className="file-tree-link" href={noteUrl(node.path, directory)} title={node.path} tabIndex={-1}>{node.name}</a>}
      {directory && <TreeView.SubTree>{node.children.map(child =>
        <TreeNode key={child.path} node={child} selected={selected} navigate={navigate} searching={searching}
          expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} bookmarkState={bookmarkState} defaultExpanded={defaultExpanded} />)}</TreeView.SubTree>}
    </TreeView.Item>
  );
}

function documentLink(path) {
  const suffix = path.toLowerCase();
  return suffix.endsWith('.md') || suffix.endsWith('.typ')
    ? noteUrl(path) : `${apiBase}/asset?path=${encodeURIComponent(path)}`;
}

function Markdown({ prepared, navigate, assetVersions, path }) {
  const active = useContext(SessionActivity);
  const html = prepared.html;
  const contentRef = useRef(null);
  useEffect(() => active ? observeSidenotes(contentRef.current) : undefined, [active]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const collapsed = new Set(readPosition(readingKey(pageBase, path)).collapsed || []);
    const next = root.cloneNode(false);
    next.innerHTML = html;
    next.querySelectorAll('.heading-section[data-heading-key]').forEach(section => {
      section.classList.toggle('is-collapsed', collapsed.has(section.dataset.headingKey));
    });
    morphdom(root, next, { childrenOnly: true,
      onBeforeElUpdated(from, to) {
        if (from.tagName === 'DETAILS' && from.hasAttribute('open')) to.setAttribute('open', '');
        return true;
      } });
    updateHeadingAvailability(root);
  }, [html, path]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    if (active) return observeMarkdownPosition(root.closest('.main-panel'), root);
  }, [active]);
  useEffect(() => {
    updateAssetVersions(contentRef.current, assetVersions);
  }, [html, assetVersions]);
  function toggleSummary(summary) {
    const section = summary.closest('.heading-section');
    section?.classList.toggle('is-collapsed');
    if (contentRef.current) {
      updateHeadingAvailability(contentRef.current);
      savePosition(readingKey(pageBase, path), { collapsed: [...contentRef.current.querySelectorAll('.heading-section.is-collapsed')]
        .map(section => section.dataset.headingKey) });
    }
  }
  function click(event) {
    const summary = event.target.closest('.heading-summary');
    if (summary && summary.getAttribute('aria-disabled') !== 'true') {
      toggleSummary(summary);
      return;
    }
    const link = event.target.closest('a[href]');
    if (link && link.origin === location.origin && link.pathname.startsWith(treeBase)) {
      event.preventDefault();
      navigate(decodeURIComponent(link.pathname.slice(treeBase.length)));
    }
  }
  function keyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const summary = event.target.closest('.heading-summary');
    if (!summary || summary.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    toggleSummary(summary);
  }
  return <div id="content" ref={contentRef} className="rendered-markdown" onClick={click} onKeyDown={keyDown} />;
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
    id: `typst-symbol-${index}`, name: heading.name, level: heading.level, line: heading.line, position: heading.position,
  }));
  if (document.type !== 'markdown') return [];
  const dom = new DOMParser().parseFromString(document.html, 'text/html');
  return [...dom.querySelectorAll('section.heading-section > .heading-summary > :is(h1,h2,h3,h4,h5,h6)')]
    .filter(heading => heading.id).map(heading => ({
      id: heading.id, name: heading.textContent.trim(), level: Number(heading.tagName.slice(1)),
      line: Number(heading.dataset.sourceLine) + 1,
    }));
}

function RawView({ document, targetLine }) {
  const source = document.source ?? document.text ?? '';
  const language = rawLanguage(document.name);
  const highlighted = useMemo(() => highlightRaw(source, document.name), [document.name, source]);
  const lines = Math.max(1, source.split('\n').length);
  return <div className="raw-view" aria-label="Source code">
    <div className="raw-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index} id={`L${index + 1}`} className={targetLine === index + 1 ? 'target-line' : undefined}>{index + 1}</span>)}</div>
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

function Preview({ document, prepared, navigate, previewZoom, assetVersions, onExpired, onScale, onScroll, onNavigate, fitRequest }) {
  if (document.type === 'pdf') return <DocumentViewport key={document.path} pageCount={document.pages?.length || 0} scale={previewZoom.scale} onScale={onScale} onScroll={onScroll} onNavigate={onNavigate} fitRequest={fitRequest}>
    <PdfPages key={`${document.path}:${document.modified}`} pages={document.pages} scale={previewZoom.scale} modified={document.modified} />
  </DocumentViewport>;
  if (document.type === 'markdown') return <Markdown prepared={prepared} navigate={navigate} assetVersions={assetVersions} path={document.path} />;
  if (document.type === 'typst') return (
    <DocumentViewport key={document.path} pageCount={document.pages?.length || 0} scale={previewZoom.scale} onScale={onScale} onScroll={onScroll} onNavigate={onNavigate} fitRequest={fitRequest}><div className="typst-pages">
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
      <TypstPages pages={document.pages || []} scale={previewZoom.scale} onExpired={onExpired} />
    </div></DocumentViewport>
  );
  if (document.type === 'image') return <div className="image-preview"><img src={`${document.url}&v=${assetVersions[document.path] || 0}`} alt={document.name} /></div>;
  if (document.type === 'binary') return <div className="status"><p>{document.format?.toUpperCase() || 'Binary file'} · {document.mime}</p><p>Preview is unavailable for this format.</p><a href={document.url} download={document.name}>Download file</a></div>;
  return <pre className="text-preview">{document.text}</pre>;
}

function App() {
  const active = useContext(SessionActivity);
  const [initialSidebar] = useState(() => readSidebarState(apiBase));
  const activityRef = useRef(active);
  activityRef.current = active;
  const [searchConfig, setSearchConfig] = useState(() => routeKind === 'search'
    ? { query: new URLSearchParams(location.search).get('q') || '', scope: new URLSearchParams(location.search).get('scope') || '' }
    : { query: '' });
  const [targetLine, setTargetLine] = useState(() => Number(new URLSearchParams(location.search).get('line')) || null);
  const pendingTypstNavigation = useRef(null);
  const pendingSymbolNavigation = useRef(null);
  const [selected, setSelected] = useState(() => currentPath());
  const { tree, index: treeIndex, loading: treeLoading, error: treeError } = useFileTree(apiBase, selected, active);
  const bookmarkState = useBookmarks(active);
  const [document, setDocument] = useState(null);
  const [recentOnly, setRecentOnly] = useState(() => Boolean(initialSidebar.recentOnly));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const recentState = useRecentFiles(active, !error && document?.path === selected ? selected : null);
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
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [bookmarkExpandedPaths, setBookmarkExpandedPaths] = useState({});
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const [fileView, setFileView] = useState('preview');
  const activeView = document?.type === 'text' ? 'raw' : document?.type === 'binary' ? 'preview' : fileView;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 767px)').matches);
  const [filesVisible, setFilesVisible] = useState(() => initialSidebar.filesVisible ?? !matchMedia('(max-width: 767px)').matches);
  const sidebarToggleRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (initialSidebar.sidebarWidth !== undefined) return initialSidebar.sidebarWidth;
    try {
      const saved = Number(localStorage.getItem('library-sidebar-width'));
      return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 245;
    } catch { return 245; }
  });
  const [sidebarTab, setSidebarTab] = useState(() => ['search', 'git'].includes(routeKind) ? routeKind
    : initialSidebar.bookmarksOnly ? 'bookmarks' : initialSidebar.sidebarTab || 'files');
  const bookmarksOnly = sidebarTab === 'bookmarks';
  const [gitPath, setGitPath] = useState(() => routeKind === 'git' ? new URLSearchParams(location.search).get('path') : null);
  const [gitScope, setGitScope] = useState(() => new URLSearchParams(location.search).get('scope') || 'unstaged');
  const gitState = useGitStatus(active && ((sidebarTab === 'git' && filesVisible) || (gitPath !== null && sidebarTab !== 'search')));
  const [sortMode, setSortMode] = useState(() => initialSidebar.sortMode || 'name');
  const nextSortMode = { name: 'modified', modified: 'name' }[sortMode];
  const sortLabels = { name: 'name', modified: 'modified time (newest first)' };
  const sortTitle = `Sorted by ${sortLabels[sortMode]}; click to sort by ${sortLabels[nextSortMode]}`;
  const [locateRequest, setLocateRequest] = useState(0);
  const [fileSearchCollapsed, setFileSearchCollapsed] = useState(() => initialSidebar.fileSearchCollapsed ?? true);
  useEffect(() => {
    if (active) saveSidebarState(apiBase, { sidebarTab, filesVisible, sidebarWidth, bookmarksOnly, recentOnly, fileSearchCollapsed, sortMode });
  }, [active, sidebarTab, filesVisible, sidebarWidth, bookmarksOnly, recentOnly, fileSearchCollapsed, sortMode]);
  const fileSearchRef = useRef(null);
  const filesScrollRef = useRef(null);
  const filesScrollTop = useRef(0);
  const restoreFilesScroll = useCallback(element => {
    filesScrollRef.current = element;
    if (element) element.scrollTop = filesScrollTop.current;
  }, []);
  const searchMode = sidebarTab === 'search';
  const [fitRequest, setFitRequest] = useState(0);
  const [previewZoom, setPreviewZoom] = useState({ scale: 1 });
  const [pathBarHidden, setPathBarHidden] = useState(false);
  const viewportScrollStarted = useRef(false);
  const [copiedAction, setCopiedAction] = useState('');
  const [copyError, setCopyError] = useState('');
  const [openingDirectory, setOpeningDirectory] = useState(false);
  const [directoryOpenError, setDirectoryOpenError] = useState('');
  const [dark, setDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [toolbarStuck, setToolbarStuck] = useState(false);
  const [currentSourceLine, setCurrentSourceLine] = useState(null);
  const [sourceLinePending, setSourceLinePending] = useState(true);
  const sourceLineTimer = useRef(null);
  const updateSourceLine = useRef(null);
  const toolbarRef = useRef(null);
  const toolbarSentinelRef = useRef(null);
  const mainPanelRef = useRef(null);

  useEffect(() => {
    if (!active || activeView !== 'preview' || searchMode || !document || ['typst', 'pdf'].includes(document.type)) return;
    return enableSmoothWheel(mainPanelRef.current);
  }, [activeView, searchMode, selected, document?.type, active]);

  updateSourceLine.current = () => {
    if (gitPath !== null || searchMode || pendingSymbolNavigation.current) {
      setSourceLinePending(false);
      return;
    }
    const toolbar = toolbarRef.current;
    const panel = mainPanelRef.current;
    if (panel && (['markdown', 'typst'].includes(document?.type) || activeView === 'raw')) {
      const line = sourceLineAtViewport(panel, document, activeView,
        (toolbar?.getBoundingClientRect().height || 0) + 12);
      setCurrentSourceLine(line ? Math.max(1, Math.min(document.lineCount || line, line)) : null);
      if (line && !pendingTypstNavigation.current && document.path === selected)
        savePosition(readingKey(pageBase, document.path), { line, view: activeView, scale: previewZoom.scale });
    } else {
      setCurrentSourceLine(null);
      if (document?.type === 'pdf' && activeView === 'preview' && document.path === selected) {
        const viewport = panel?.querySelector('.document-viewport');
        if (viewport && !pendingTypstNavigation.current) {
          const rect = viewport.getBoundingClientRect();
          const page = pagePosition(viewport, rect.left + viewport.clientWidth / 2, rect.top + 12);
          if (page) savePosition(readingKey(pageBase, document.path), { page, scale: previewZoom.scale });
        }
      }
    }
    setSourceLinePending(false);
  };

  function scheduleSourceLine() {
    setSourceLinePending(true);
    clearTimeout(sourceLineTimer.current);
    sourceLineTimer.current = setTimeout(() => updateSourceLine.current?.(), 150);
  }

  function documentViewportNavigate(delta) {
    viewportScrollStarted.current = true;
    const viewport = mainPanelRef.current?.querySelector('.document-viewport');
    if (viewport && delta > 0 && viewport.scrollHeight > viewport.clientHeight)
      setPathBarHidden(true);
  }
  function documentViewportScroll(event) {
    scheduleSourceLine();
    const top = event.currentTarget.scrollTop;
    setToolbarStuck(top > 8);
    if (viewportScrollStarted.current) setPathBarHidden(top > 2);
  }
  useEffect(() => {
    viewportScrollStarted.current = false;
    setPathBarHidden(false);
  }, [document?.path, searchMode]);

  function resizeSidebar(event) {
    const workspace = event.currentTarget.parentElement;
    const bounds = workspace.getBoundingClientRect();
    const width = Math.max(180, Math.min(480, event.clientX - bounds.left - (workspace.querySelector('.sidebar-rail')?.getBoundingClientRect().width || 0)));
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
    const media = matchMedia('(max-width: 767px)');
    const update = event => { setNarrow(event.matches); setFilesVisible(!event.matches); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { window.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => {
    setToolbarStuck(false);
    const sentinel = toolbarSentinelRef.current, panel = mainPanelRef.current;
    if (!sentinel || !panel || panel.querySelector('.document-viewport')) return;
    const observer = new IntersectionObserver(([entry]) => {
      setToolbarStuck(Boolean(entry.rootBounds && entry.boundingClientRect.bottom <= entry.rootBounds.top));
    }, { root: panel, threshold: [0, 1] });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [document?.path, activeView, searchMode, Boolean(error)]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(scheduleSourceLine);
    const panel = mainPanelRef.current;
    const observer = new ResizeObserver(scheduleSourceLine);
    if (panel) {
      observer.observe(panel);
      const content = panel.querySelector('.rendered-markdown, .raw-view, .typst-pages');
      if (content) observer.observe(content);
    }
    return () => { cancelAnimationFrame(frame); observer.disconnect(); clearTimeout(sourceLineTimer.current); };
  }, [document, activeView, previewZoom, narrow, searchMode, active]);
  useEffect(() => {
    if (!active) return;
    const client = crypto.randomUUID();
    const repo = repoId || '';
    const activity = () => {
      if (!window.document.hidden) fetch('/api/library/activity', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }).catch(() => {});
    };
    const openDocument = event => {
      const request = parseDocumentOpenEvent(event);
      if (!request) return;
      updateSourceLine.current?.();
      if (request.repo !== repo && repo) { syncReadingPositions().then(() => location.assign(request.url)).catch(cause => setError(String(cause))); return; }
      const target = new URL(request.url, location.origin);
      history.pushState(null, '', target.pathname + target.search);
      dispatchEvent(new PopStateEvent('popstate'));
      setDocumentRevision(value => value + 1);
      window.focus();
    };
    const stream = visibleEvents(`/api/library/session?${new URLSearchParams({ client, repo })}`, {
      connected: activity, 'document-open': openDocument, open: openDocument,
    });
    addEventListener('focus', activity);
    window.document.addEventListener('visibilitychange', activity);
    return () => { stream.close(); removeEventListener('focus', activity);
      window.document.removeEventListener('visibilitychange', activity); };
  }, [active]);
  const prepared = useMemo(() => document?.type === 'markdown'
    ? prepareMarkdown(document, documentLink) : null, [document]);
  const assetPaths = document?.path === selected ? prepared?.assets || [] : [];
  const assetPathKey = assetPaths.join('\0');
  useEffect(() => {
    if (!selected || !active) return;
    const query = new URLSearchParams({ path: selected });
    for (const path of assetPathKey.split('\0').filter(Boolean)) query.append('asset', path);
    const changed = () => {
      updateSourceLine.current?.();
      setDocumentRevision(value => value + 1);
      setAssetVersions(versions => {
        const next = { ...versions }, now = Date.now();
        for (const path of [selected, ...assetPathKey.split('\0').filter(Boolean)]) next[path] = now;
        return next;
      });
    };
    let connected = window.document.hidden || document?.path === selected;
    const stream = visibleEvents(`${apiBase}/library/events?${query}`, {
      document: changed,
      connected: () => {
        // The initial document fetch is already in progress. Later connections
        // must catch up on edits made while hidden or disconnected.
        if (connected) changed();
        connected = true;
      },
      assets: event => {
        const paths = JSON.parse(event.data).paths || [];
        setAssetVersions(versions => {
          const next = { ...versions };
          for (const path of paths) next[path] = Date.now();
          return next;
        });
      },
    });
    return () => stream.close();
  }, [selected, assetPathKey, apiBase, active]);
  useEffect(() => {
    const pop = () => {
      if (!activityRef.current) return;
      pendingSymbolNavigation.current = null;
      const kind = currentRouteKind();
      const params = new URLSearchParams(location.search);
      setGitPath(kind === 'git' ? params.get('path') : null);
      if (kind === 'git') setGitScope(params.get('scope') || 'unstaged');
      if (kind === 'search') setSearchConfig({ query: params.get('q') || '', scope: params.get('scope') || '' });
      updateSourceLine.current?.();
      const path = currentPath();
      setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
      setSidebarTab(tab => kind === 'search' || kind === 'git' ? kind : ['search', 'git'].includes(tab) ? 'files' : tab);
      setTargetLine(Number(new URLSearchParams(location.search).get('line')) || null);
      setSelected(path);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const capture = () => { updateSourceLine.current?.(); };
    const exit = () => { capture(); syncReadingPositions(true).catch(() => {}); };
    const hidden = () => { if (window.document.hidden) exit(); };
    window.document.addEventListener('visibilitychange', hidden);
    addEventListener('reading-capture', capture);
    addEventListener('pagehide', exit);
    return () => { window.document.removeEventListener('visibilitychange', hidden); removeEventListener('reading-capture', capture); removeEventListener('pagehide', exit); };
  }, []);
  useDocumentLease(apiBase, document?.path === selected ? selected : null);
  const selectedNode = treeIndex.get(selected);
  const selectedNodePath = selectedNode?.path;
  const selectedNodeType = selectedNode?.type;
  useEffect(() => {
    const name = selected.split('/').filter(Boolean).at(-1) || tree?.name || 'Notes';
    if (active) window.document.title = name;
  }, [selected, tree?.name, active]);
  useEffect(() => {
    if (!tree) return;
    if (selected && !selectedNode) {
      if (treeLoading) { setLoading(true); setDocument(null); setError(''); return; }
      setLoading(false);
      setError('File not found in the notes library');
      setDocument(null);
      return;
    }
    if (!selectedNode || selectedNode.type === 'directory') { setLoading(false); setDocument(null); setError(''); return; }
    const controller = new AbortController();
    setLoading(true);
    if (document?.path !== selected) setDocument(null);
    setError('');
    fetch(`${apiBase}/document?path=${encodeURIComponent(selected)}`, { signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }).then(async value => {
      if (controller.signal.aborted) return;
      if (document?.path === value.path && document.modified === value.modified) return;
      const stored = await loadPosition(readingKey(pageBase, value.path), apiBase, value.path);
      const saved = stored;
      if (controller.signal.aborted) return;
      const query = new URLSearchParams(location.search);
      const line = Number(query.get('line')) || saved.line || 1;
      const view = query.get('view') || (query.has('line') ? 'raw' : saved.view || 'preview');
      pendingTypstNavigation.current = { path: value.path, line, page: saved.page };
      setFileView(view === 'raw' ? 'raw' : 'preview');
      setPreviewZoom({ scale: saved.scale || 1 });
      setDocument(value);
    })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selected, selectedNodePath, selectedNodeType, documentRevision, selected && !selectedNode && treeLoading]);
  useEffect(() => {
    if (document?.path !== selected || !targetLine) return;
    const view = new URLSearchParams(location.search).get('view') || 'raw';
    pendingTypstNavigation.current = { path: document.path, line: targetLine };
    setFileView(view === 'preview' ? 'preview' : 'raw');
  }, [targetLine]);
  useEffect(() => {
    if (!targetLine || !document || activeView !== 'raw' || searchMode || pendingSymbolNavigation.current) return;
    if (document.type === 'typst') {
      const frame = requestAnimationFrame(() => {
        const panel = mainPanelRef.current;
        if (panel) scrollToTypstSource(panel, document, 'raw', targetLine,
          (toolbarRef.current?.getBoundingClientRect().height || 0) + 12);
      });
      return () => cancelAnimationFrame(frame);
    }
    const frame = requestAnimationFrame(() => mainPanelRef.current?.querySelector(`#L${targetLine}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [document, targetLine, activeView, searchMode]);
  useEffect(() => {
    const pending = pendingTypstNavigation.current;
    if (!pending || searchMode || pendingSymbolNavigation.current) return;
    if (pending.path !== document?.path) return;
    const frame = requestAnimationFrame(() => {
      if (pendingTypstNavigation.current !== pending || pendingSymbolNavigation.current) return;
      pendingTypstNavigation.current = null;
      const panel = mainPanelRef.current;
      if (document?.type === 'pdf' && activeView === 'preview' && pending.page) {
        const viewport = panel?.querySelector('.document-viewport');
        if (viewport) {
          const rect = viewport.getBoundingClientRect();
          restorePagePosition(viewport, pending.page, rect.left + viewport.clientWidth / 2, rect.top + 12);
        }
      } else if (panel) scrollToTypstSource(panel, document, activeView, pending.line,
        (toolbarRef.current?.getBoundingClientRect().height || 0) + 12, pending);
      const params = new URLSearchParams(location.search);
      if (Number(params.get('line')) === pending.line) {
        params.delete('line');
        const query = params.toString();
        const hash = location.hash === `#L${pending.line}` ? '' : location.hash;
        history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${hash}`);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [activeView, document, targetLine, searchMode]);

  function navigate(path, directory = false, line = null) {
    updateSourceLine.current?.();
    pendingSymbolNavigation.current = null;
    setGitPath(null);
    setSidebarTab(tab => tab === 'search' ? 'files' : tab);
    setTargetLine(line);
    history.pushState(null, '', noteUrl(path, directory) + (line ? `?line=${line}#L${line}` : ''));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    if (matchMedia('(max-width: 767px)').matches) setFilesVisible(false);
    if (directory) setSidebarTab('files');
  }
  const parts = (gitPath ?? selected).split('/').filter(Boolean);
  const entries = selectedNode?.type === 'directory' ? selectedNode.children : !selected ? tree?.children : null;
  const filteredTree = useMemo(() => {
    const nodes = sortMode === 'name' ? tree?.children : sortFileTree(tree?.children);
    const filtered = fileTreeForView(nodes, { bookmarksOnly, bookmarks: bookmarkState.bookmarks, query: search });
    return bookmarksOnly ? fileTreeForView(filtered, { query: bookmarkSearch }) : filtered;
  }, [tree, search, bookmarkSearch, sortMode, bookmarksOnly, bookmarkState.bookmarks]);
  useLayoutEffect(() => {
    if (!locateRequest) return;
    const panel = filesScrollRef.current;
    const item = panel?.querySelector('[aria-current="true"]');
    if (!item) return;
    const row = item.querySelector('.PRIVATE_TreeView-item-container') || item;
    panel.scrollTop += row.getBoundingClientRect().top - panel.getBoundingClientRect().top
      - (panel.clientHeight - row.getBoundingClientRect().height) / 2;
    filesScrollTop.current = panel.scrollTop;
  }, [locateRequest]);
  const symbols = useMemo(() => document ? documentSymbols(document) : [], [document]);
  const filteredSymbols = useMemo(() => {
    const term = symbolSearch.trim().toLocaleLowerCase();
    return term ? symbols.filter(symbol => symbol.name.toLocaleLowerCase().includes(term)) : symbols;
  }, [symbols, symbolSearch]);

  function switchFileView(view) {
    if (view === activeView) return;
    const panel = mainPanelRef.current;
    if (['markdown', 'typst'].includes(document.type) && panel) {
      const line = sourceLineAtViewport(panel, document, activeView,
        (toolbarRef.current?.getBoundingClientRect().height || 0) + 12);
      if (line) pendingTypstNavigation.current = { path: document.path, line };
    }
    setFileView(view);
  }

  function documentClick(event) {
    if (document?.type !== 'typst' || activeView !== 'preview') return;
    const link = event.target.closest('a[data-typst-page]');
    if (!link || !mainPanelRef.current) return;
    const page = Number(link.dataset.typstPage), size = document.pages[page - 1];
    if (!size) return;
    event.preventDefault(); event.stopPropagation();
    scrollToTypstSource(mainPanelRef.current, document, 'preview', 1,
      (toolbarRef.current?.getBoundingClientRect().height || 0) + 12,
      { position: { page, y: Number(link.dataset.typstY) / size.height }, behavior: 'smooth' });
  }

  function jumpToSymbol(symbol) {
    pendingTypstNavigation.current = null;
    if (searchMode) {
      pendingSymbolNavigation.current = { ...symbol, path: document.path };
      setGitPath(null);
      setSidebarTab('files');
      const location = symbol.line
        ? `?line=${symbol.line}&view=${activeView}#L${symbol.line}`
        : symbol.page ? `#page=${symbol.page}` : '';
      history.pushState(null, '', noteUrl(selected) + location);
      if (narrow) setFilesVisible(false);
      return;
    }
    if (narrow) setFilesVisible(false);
    requestAnimationFrame(() => scrollToSymbol(symbol));
  }
  function scrollToSymbol(symbol) {
      const panel = mainPanelRef.current?.querySelector('.document-viewport') || mainPanelRef.current;
      if (!panel || !document) return false;
      if (document.type === 'typst' || (document.type === 'markdown' && activeView === 'raw')) {
        scrollToTypstSource(panel, document, activeView, symbol.line,
          (toolbarRef.current?.getBoundingClientRect().height || 0) + 12,
          { position: symbol.position, behavior: 'instant', navigation: 'outline' });
        return true;
      }
      let target;
      if (document.type === 'markdown') {
        target = panel.querySelector(`#${CSS.escape(symbol.id)}`);
        for (let section = target?.parentElement?.closest('.heading-section'); section;
          section = section.parentElement?.closest('.heading-section')) section.classList.remove('is-collapsed');
        const root = panel.querySelector('.rendered-markdown');
        if (root) updateHeadingAvailability(root);
      } else if (document.type === 'pdf') {
        target = panel.querySelectorAll('.pdf-page')[symbol.page - 1];
      }
      if (!target) {
        if (document.type === 'markdown' && symbol.line)
          scrollToTypstSource(panel, document, activeView, symbol.line, 12);
        return false;
      }
      const toolbarHeight = panel.matches?.('.document-viewport') ? 0 : toolbarRef.current?.getBoundingClientRect().height || 0;
      const top = panel.scrollTop + target.getBoundingClientRect().top
        - panel.getBoundingClientRect().top - panel.clientTop - toolbarHeight - 12;
      // scrollIntoView also scrolls the hidden shell ancestors, shifting the whole UI.
      panel.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      return true;
  }
  useEffect(() => {
    const symbol = pendingSymbolNavigation.current;
    if (searchMode || !symbol || document?.path !== symbol.path || selected !== symbol.path) return;
    const frame = requestAnimationFrame(() => {
      if (pendingSymbolNavigation.current !== symbol) return;
      // Cancelled frames retain the request; completed attempts never block later navigation.
      scrollToSymbol(symbol);
      pendingSymbolNavigation.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMode, document, selected, activeView]);
  async function openCurrentDirectory() {
    const path = selectedNode?.type === 'directory' ? selected : selected.split('/').slice(0, -1).join('/');
    setOpeningDirectory(true);
    setDirectoryOpenError('');
    try {
      const response = await fetch(`${apiBase}/open-directory`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
      });
      const body = await response.text();
      let result;
      try { result = JSON.parse(body); } catch { /* Older services may return plain text. */ }
      if (!response.ok) {
        if (response.status === 404 && !result)
          throw new Error('Directory opening endpoint is unavailable. Restart the library service to load the new feature.');
        throw new Error(result?.error || `HTTP ${response.status}`);
      }
      if (!result?.ok) throw new Error('Unexpected response from directory opening endpoint');
    } catch (error) { setDirectoryOpenError(`Could not open directory: ${error.message}`); }
    finally { setOpeningDirectory(false); }
  }
  async function copyValue(label, value) {
    try {
      if (typeof value !== 'string' || !value) throw new Error('Path is unavailable. Reload the page and try again.');
      await navigator.clipboard.writeText(value);
      setCopiedAction(label);
      window.setTimeout(() => setCopiedAction(''), 1400);
      setCopyError('');
    } catch (cause) {
      setCopyError(`Could not copy ${label.toLowerCase()}: ${cause.message || cause}`);
    }
  }
  const codeSearch = useWorkspaceSearch({ config: searchConfig, onConfig: config => {
    setSearchConfig(config);
    if (currentRouteKind() === 'search') history.replaceState(null, '', searchUrl(repoId, config.query, config.scope, selected));
  }, navigate, active: active && searchMode,
    currentFile: selected, scrollRef: mainPanelRef, treeIndex, bookmarks: bookmarkState.bookmarks,
    symbols, onSelectSymbol: jumpToSymbol });
  function sidebarViewSelected(id) {
    return sidebarTab === id;
  }
  function selectSidebarView(id, collapse = true) {
    if (id === 'bookmarks' && sidebarTab !== 'bookmarks') setBookmarkExpandedPaths({});
    if (id === 'search' && currentRouteKind() !== 'search') history.pushState(null, '', searchUrl(repoId, searchConfig.query, searchConfig.scope, selected));
    else if (id === 'git' && currentRouteKind() !== 'git') history.pushState(null, '', gitUrl(repoId, gitPath || '', gitScope));
    else if (!['search', 'git'].includes(id) && ['search', 'git'].includes(currentRouteKind())) {
      history.pushState(null, '', noteUrl(selected));
      setGitPath(null);
    }
    setFilesVisible(!collapse || !(filesVisible && sidebarViewSelected(id)));
    setSidebarTab(id);
  }
  const sidebarContent = <>
          {sidebarTab === 'git' && filesVisible && active && <Suspense fallback={<div className="tree-loading"><Spinner size="small" /></div>}>
            <GitPanel state={gitState} selected={gitPath} scope={gitScope} onSelect={(path, scope) => {
              updateSourceLine.current?.();
              history.pushState(null, '', gitUrl(repoId, path, scope));
              setGitPath(path);
              setGitScope(scope);
              mainPanelRef.current?.scrollTo({ top: 0 });
              if (narrow) setFilesVisible(false);
            }} />
          </Suspense>}
          {active && <RepoPicker hidden={sidebarTab !== 'repos'} beforeNavigate={syncReadingPositions} />}
          {sidebarTab === 'search' ? codeSearch.sidebar : sidebarTab === 'files' || bookmarksOnly ? <>
          {bookmarksOnly && <div className="file-search bookmarks-search">
            <SearchInput size="small" onClear={() => setBookmarkSearch('')}
              aria-label="Search bookmarks" placeholder="Search bookmarks…"
              value={bookmarkSearch} onChange={event => setBookmarkSearch(event.target.value)} />
          </div>}
          {!bookmarksOnly && !recentOnly && <div
            className={`file-search files-search ${fileSearchCollapsed ? 'is-collapsed' : ''}`}
            aria-hidden={fileSearchCollapsed} inert={fileSearchCollapsed ? true : undefined}>
            <SearchInput ref={fileSearchRef} size="small" clearable clearLabel="Close file search"
              onClear={() => { setSearch(''); setFileSearchCollapsed(true); }}
              onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setSearch(''); setFileSearchCollapsed(true); } }}
              id="files-search-input" aria-label="Search files" placeholder="Go to file"
              value={search} onChange={event => setSearch(event.target.value)} />
          </div>}
          {!bookmarksOnly && (fileSearchCollapsed || recentOnly) && <div className="files-toolbar" role="toolbar" aria-label="File tree actions">
            <div className="files-toolbar-actions">
            <IconButton size="small" variant="invisible" icon={HistoryIcon}
              aria-label="Show Recent Files" title={recentOnly ? 'Show all files' : 'Recent Files'}
              aria-pressed={recentOnly} onClick={() => setRecentOnly(value => !value)} />
            <IconButton size="small" variant="invisible" icon={FoldIcon} aria-label="Collapse all folders"
              title={!recentOnly && search.trim() ? 'Clear file search to collapse folders' : 'Collapse all folders'}
              disabled={recentOnly ? !HISTORY_GROUPS.some(group => expandedPaths[`history:${group.id}`] !== false)
                : Boolean(search.trim()) || !Object.values(expandedPaths).some(Boolean)}
              onClick={() => setExpandedPaths(recentOnly ? Object.fromEntries(HISTORY_GROUPS.map(group => [`history:${group.id}`, false])) : {})} />
            <IconButton size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Locate current file"
              title="Locate current file" disabled={!selectedNode}
              onClick={() => {
                setSearch(''); setRecentOnly(false);
                setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(selected) }));
                setLocateRequest(value => value + 1);
              }} />
            <IconButton size="small" variant="invisible" icon={SortDescIcon} aria-label={sortTitle}
              tooltipDirection="s" disabled={recentOnly}
              onClick={() => setSortMode(nextSortMode)} />
            <IconButton
              size="small" variant="invisible" icon={SearchIcon} aria-label="Expand file search"
              title={search.trim() ? `Search files: ${search}` : 'Search files'}
              aria-expanded={!fileSearchCollapsed} aria-controls="files-search-input"
              onClick={() => {
                setRecentOnly(false); setFileSearchCollapsed(false);
                requestAnimationFrame(() => fileSearchRef.current?.focus());
              }} />
            </div>
          </div>}
          {bookmarksOnly && bookmarkState.error && <div className="action-error" role="alert">{bookmarkState.error}</div>}
          {treeError && <div className="action-error" role="alert">{treeError}</div>}
          <div className="tree-scroll" ref={restoreFilesScroll}
            onScroll={event => { filesScrollTop.current = event.currentTarget.scrollTop; }}>{!bookmarksOnly && recentOnly ? <RecentFiles state={recentState} renderTree={nodes => <TreeView aria-label="Browsing history">
              {nodes.map(node => <TreeNode key={node.path} node={node} selected={selected} navigate={navigate}
                searching={false} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />)}
            </TreeView>} /> : bookmarksOnly && bookmarkState.loading ? <div className="tree-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading bookmarks</span></div> : tree ? filteredTree.length ? <TreeView aria-label={bookmarksOnly ? 'Bookmarked files tree' : 'Notes tree'}>
            {filteredTree.map(node => <TreeNode key={node.path} node={node} selected={selected} navigate={navigate}
              searching={Boolean((bookmarksOnly ? bookmarkSearch : search).trim())} defaultExpanded={bookmarksOnly}
              expandedPaths={bookmarksOnly ? bookmarkExpandedPaths : expandedPaths} setExpandedPaths={bookmarksOnly ? setBookmarkExpandedPaths : setExpandedPaths}
              bookmarkState={bookmarksOnly ? bookmarkState : undefined} />)}
          </TreeView> : <div className="tree-empty">{bookmarksOnly ? bookmarkSearch.trim() ? 'No matching bookmarks' : bookmarkState.bookmarks.length ? 'No bookmarked files available' : 'Open a file to add a bookmark.' : 'No matching files'}</div> : treeLoading ? <div className="tree-loading"><Spinner size="small" /></div> : null}</div>
          </> : sidebarTab === 'symbols' ? <><div className="file-search">
            <SearchInput onClear={() => setSymbolSearch('')} aria-label="Search symbols" placeholder="Search symbols…"
              value={symbolSearch} onChange={event => setSymbolSearch(event.target.value)} />
          </div><nav className="symbols-list tree-scroll" aria-label="Document symbols">{filteredSymbols.length ?
            <ActionList variant="full">{filteredSymbols.map(symbol => <ActionList.Item key={symbol.id}
              style={{ marginInlineStart: `${Math.max(0, (symbol.level || 1) - 1) * 20}px` }}
              onSelect={() => jumpToSymbol(symbol)}><span className="symbol-name">{symbol.name}</span></ActionList.Item>)}</ActionList>
            : <div className="tree-empty">{symbols.length ? 'No matching symbols' : 'No symbols found'}</div>}</nav></> : null}
  </>;
  return <ThemeProvider colorMode={dark ? 'night' : 'day'}><BaseStyles>
    <div className={`app-shell ${filesVisible ? '' : 'files-hidden'}`}>
      <div className="workspace" style={{ '--sidebar-width': `${sidebarWidth}px` }}>
        {!narrow && <nav className="sidebar-rail" aria-label="Sidebar views">
          {sidebarViews.map(view => <IconButton key={view.id} size="medium" variant="invisible"
            className={`sidebar-rail-button${view.id === 'repos' ? ' sidebar-rail-repos' : ''}`} icon={view.icon} aria-label={view.label} tooltipDirection="e"
            aria-pressed={filesVisible && sidebarViewSelected(view.id)} aria-controls="sidebar-content"
            onClick={() => selectSidebarView(view.id)} />)}
        </nav>}
        {!narrow && <aside className="sidebar" id="sidebar-content" aria-label="Sidebar">
          {sidebarContent}
        </aside>}
        {narrow && filesVisible && <Dialog title="Sidebar" className="sidebar-drawer"
          position={{ narrow: 'bottom', regular: 'center' }} returnFocusRef={sidebarToggleRef}
          onClose={() => setFilesVisible(false)}
          renderHeader={({ dialogLabelId }) => <div className="sidebar-drawer-header">
            <span className="visually-hidden" id={dialogLabelId}>Sidebar</span>
            <nav className="sidebar-drawer-views" aria-label="Sidebar views">
              {sidebarViews.map(view => <IconButton key={view.id} size="medium" variant="invisible"
                className="sidebar-drawer-view-button" icon={view.icon} aria-label={view.label}
                title={view.label} tooltipDirection="s" aria-pressed={sidebarViewSelected(view.id)}
                aria-controls="sidebar-content" onClick={() => selectSidebarView(view.id, false)} />)}
            </nav>
            </div>}
          renderBody={() => <div className="sidebar sidebar-drawer-content" id="sidebar-content">{sidebarContent}</div>} />}
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
        <main className={`main-panel${gitPath === null && !searchMode && !error && activeView === 'preview' && ['typst', 'pdf'].includes(document?.type) ? ` has-document-viewport${pathBarHidden ? ' path-bar-hidden' : ''}` : ''}`} ref={mainPanelRef} onScroll={scheduleSourceLine} onClick={gitPath === null ? documentClick : undefined}>
          <div className="page-header" inert={gitPath === null && pathBarHidden && activeView === 'preview' && ['pdf', 'typst'].includes(document?.type) ? true : undefined}>
            <div className="path-row">
              <Breadcrumbs>
                <Breadcrumbs.Item href={`${pageBase}/`} onClick={event => { event.preventDefault(); navigate(''); }}>{tree?.name || 'Notes'}</Breadcrumbs.Item>
                {searchMode ? <Breadcrumbs.Item selected>Search</Breadcrumbs.Item> : parts.map((part, index) => <Breadcrumbs.Item key={index} href={noteUrl(parts.slice(0, index + 1).join('/'))}
                  selected={index === parts.length - 1} onClick={event => { event.preventDefault(); navigate(parts.slice(0, index + 1).join('/')); }}>
                  {part}</Breadcrumbs.Item>)}
              </Breadcrumbs>
              <div className="path-actions">
                {narrow && (gitPath !== null || searchMode || !document || error) && <IconButton ref={sidebarToggleRef} hidden={filesVisible}
                  size="small" variant="invisible" className="sidebar-toggle" icon={SidebarExpandIcon}
                  aria-label="Show sidebar" title="Show sidebar" aria-expanded={filesVisible}
                  aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />}
              </div>
            </div>
          </div>
          {searchMode && codeSearch.results}
          {!searchMode && gitPath !== null && <Suspense fallback={<div className="status"><Spinner /> Loading diff…</div>}>
            <GitDiffView key={`${gitScope}:${gitPath}`} path={gitPath} scope={gitScope} active={active} revision={gitState.updatedAt}
              onOpen={treeIndex.has(gitPath) ? () => navigate(gitPath) : undefined}
              onClose={() => { history.pushState(null, '', noteUrl(selected)); setGitPath(null); }} />
          </Suspense>}
          <div className="content-panel" hidden={searchMode || gitPath !== null}>
            {copyError && <div className="action-error" role="alert">{copyError}</div>}
            {bookmarkState.error && !bookmarksOnly && <div className="action-error" role="alert">{bookmarkState.error}</div>}
            {loading && !document && <div className="status" role="status"><span className="rendering-label">Rendering</span></div>}
            {!loading && error && <LibraryError error={error} path={selected} navigate={navigate} />}
            {!loading && !error && entries && <div className="directory-list">
              <div className="directory-heading">
                <span>{entries.length} items</span>
                <div className="toolbar-actions" role="group" aria-label="Directory actions">
                  <IconButton size="small" variant="invisible" icon={FileDirectoryOpenFillIcon}
                    aria-label="Open in Explorer" title="Open in Explorer"
                    disabled={openingDirectory} onClick={openCurrentDirectory} />
                  <IconButton size="small" variant="invisible" icon={CopyIcon}
                    aria-label={copiedAction === 'absolute path' ? 'Absolute path copied' : 'Copy absolute path'}
                    title={copiedAction === 'absolute path' ? 'Absolute path copied' : 'Copy absolute path'}
                    onClick={() => {
                      const root = tree.absolutePath;
                      const separator = root?.includes('\\') ? '\\' : '/';
                      const path = selectedNode?.absolutePath || (root && (selected
                        ? `${root.replace(/[\\/]+$/, '')}${separator}${selected.split('/').join(separator)}` : root));
                      void copyValue('absolute path', path);
                    }} />
                </div>
              </div>
              {directoryOpenError && <div className="action-error" role="alert">{directoryOpenError}</div>}
              {entries.map(node => <a key={node.path} href={noteUrl(node.path, node.type === 'directory')}
                onClick={event => { event.preventDefault(); navigate(node.path, node.type === 'directory'); }}>
                {node.type === 'directory' ? <FileDirectoryIcon /> : fileIcon(node.name)}<span>{node.name}</span>
                {node.type === 'directory' && node.modified && <time className="directory-modified" dateTime={node.modified}
                  title={formatModified(node.modified)}>{formatRelativeModified(node.modified)}</time>}
              </a>)}
            </div>}
            {!error && document && <>
              <div className="toolbar-sentinel" ref={toolbarSentinelRef} aria-hidden="true" />
              <div className="file-toolbar" ref={toolbarRef}>
                <div className="file-tabs" role="tablist" aria-label="File view">
                  {document.type !== 'text' && <button className={`file-tab ${activeView === 'preview' ? 'selected' : ''}`} role="tab"
                    aria-selected={activeView === 'preview'} onClick={() => switchFileView('preview')}>Preview</button>}
                  {!['image', 'pdf', 'binary'].includes(document.type) && <button className={`file-tab ${activeView === 'raw' ? 'selected' : ''}`} role="tab"
                    aria-selected={activeView === 'raw'} onClick={() => switchFileView('raw')}>Raw</button>}
                </div>
                <span className="file-current-line" aria-busy={document.lineCount != null && sourceLinePending}>
                  {document.lineCount != null && <>{`${currentSourceLine ?? '—'} / ${document.lineCount} lines · `}</>}
                  {sizeLabel(document.size)}
                  {document.modified && <>{' · '}<time dateTime={document.modified} title={formatModified(document.modified)}>
                    {formatRelativeModified(document.modified)}
                  </time></>}
                </span>
                <div className="toolbar-actions" role="group" aria-label="Page actions">
                  {toolbarStuck && <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
                    title="Back to top" onClick={() => (mainPanelRef.current?.querySelector('.document-viewport') || mainPanelRef.current)?.scrollTo({ top: 0, behavior: 'smooth' })} />}
                  {toolbarStuck && activeView === 'preview' && ['typst', 'pdf'].includes(document.type) && <IconButton
                    size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Fit and recenter page"
                    title="Fit and recenter page" onClick={() => setFitRequest(value => value + 1)} />}
                  {narrow && <IconButton ref={sidebarToggleRef} hidden={filesVisible} size="small" variant="invisible"
                    className="sidebar-toggle" icon={SidebarExpandIcon} aria-label="Show sidebar" title="Show sidebar"
                    aria-expanded={filesVisible} aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />}
                <ActionMenu>
                  <ActionMenu.Anchor>
                    <IconButton size="small" variant="invisible" className="path-actions-button" icon={KebabHorizontalIcon}
                      aria-label="Menu" title="Menu" />
                  </ActionMenu.Anchor>
                  <ActionMenu.Overlay>
                    <ActionList>
                      <BookmarkMenu state={bookmarkState} path={document.path} />
                      <ActionList.LinkItem href={noteUrl(document.path)} target="_blank" rel="noopener noreferrer">
                        Open in New Tab
                      </ActionList.LinkItem>
                      <ActionList.LinkItem href={`${apiBase}/asset?path=${encodeURIComponent(document.path)}`}
                        target="_blank" rel="noopener noreferrer">
                        Open raw file
                      </ActionList.LinkItem>
                      <ActionList.Item onSelect={() => copyValue('path', document.path)}>
                        Copy path{copiedAction === 'path' ? ' · Copied' : ''}
                      </ActionList.Item>
                      <ActionList.Item onSelect={() => copyValue('absolute path', document.absolutePath)}>
                        Copy absolute path{copiedAction === 'absolute path' ? ' · Copied' : ''}
                      </ActionList.Item>
                    </ActionList>
                  </ActionMenu.Overlay>
                </ActionMenu>

                </div>
              </div>
              {activeView === 'raw' && document.type !== 'image' ? <RawView document={document} targetLine={targetLine} />
                : <Preview document={document} prepared={prepared} navigate={navigate} previewZoom={previewZoom}
                  assetVersions={assetVersions} onExpired={onExpired} onScale={zoom => {
                    setPreviewZoom(zoom);
                    savePosition(readingKey(pageBase, document.path), { scale: zoom.scale });
                  }} onScroll={documentViewportScroll} onNavigate={documentViewportNavigate} fitRequest={fitRequest} />}
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles></ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<BrowserSession><App /></BrowserSession>);
