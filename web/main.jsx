import { useDocumentLease } from './document-session.jsx';
import { BrowserSession, SessionActivity } from './session-activity.jsx';
import { formatRelativeModified, HISTORY_GROUPS } from './time-labels.mjs';
import { visibleEvents } from './visible-events.mjs';
import { parseDocumentOpenEvent } from './session-events.mjs';
import { sortFileTree, fileTreeForView, isPlainTreeActivation, indexFileTree } from './file-tree.mjs';
import { useFileTree } from './use-file-tree.jsx';
import { apiBase, pageBase, repoId, routeKind, fileUrl } from './urls.mjs';
import { searchUrl, gitUrl, parseRepositoryLocation } from '../shared/paths.mjs';
import React, { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionList, ActionMenu, BaseStyles, Breadcrumbs, IconButton, Spinner, ThemeProvider, TreeView, Tooltip } from '@primer/react';
import { Dialog as SideSheet } from '@primer/react/experimental';
import { SearchInput } from './search-input.jsx';
import { PinIcon, XIcon, CopyIcon, FileDirectoryOpenFillIcon, FocusCenterIcon, SortDescIcon, FoldIcon, ArrowUpIcon, FileDirectoryIcon, FileIcon, MarkdownIcon, SearchIcon, KebabHorizontalIcon, SidebarExpandIcon, ListUnorderedIcon, RepoIcon, GitBranchIcon, BookmarkIcon, HistoryIcon } from '@primer/octicons-react';
import { BookmarkMenu, useBookmarks } from './bookmarks.jsx';
import { RecentFiles, useRecentFiles } from './recent-files.jsx';
import { RepoPicker } from './repo-picker.jsx';
import { useWorkspaceSearch } from './workspace-search.jsx';
import { useGitStatus } from './use-git-status.jsx';
import { readSidebarState, saveSidebarState } from './sidebar-state.mjs';
import { Reader } from './reader.jsx';
import { hasDocumentViewport } from './preview-kind.mjs';
import { syncReadingPositions, loadPosition, readingKey } from './reading-state.mjs';
import { readerRouteRequest } from './reader-session.mjs';
import { activeSymbolId, revealSymbolVertically } from './active-symbol.mjs';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/base/motion/motion.css';
import './markdown/theme.css';
import './markdown/heading-sections.css';
import './markdown/highlight.css';
import './markdown/footnotes.css';
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


function documentSymbols(document) {
  if (document.type === 'pdf') return (document.outline || []).map((item, index) => ({
    id: `pdf-symbol-${index}`, name: item.name, level: item.level, page: item.page,
  }));
  if (document.type === 'typst') return (document.outline || []).map((heading, index) => ({
    id: `typst-symbol-${index}`, name: heading.name, level: heading.level, line: heading.line, position: heading.position,
  }));
  if (document.type !== 'markdown') return [];
  const dom = new DOMParser().parseFromString(document.html, 'text/html');
  return [...dom.querySelectorAll(':is(h1,h2,h3,h4,h5,h6)[data-source-line]')]
    .filter(heading => heading.id).map(heading => ({
      id: heading.id, name: heading.textContent.trim(), level: Number(heading.tagName.slice(1)),
      line: Number(heading.dataset.sourceLine) + 1,
    }));
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

function App() {
  const active = useContext(SessionActivity);
  const [initialSidebar] = useState(() => readSidebarState(apiBase));
  const [searchConfig, setSearchConfig] = useState(() => routeKind === 'search'
    ? { query: new URLSearchParams(location.search).get('q') || '', scope: new URLSearchParams(location.search).get('scope') || '' }
    : { query: '' });
  const [readerRequest, setReaderRequest] = useState(() => readerRouteRequest(currentPath(), location.search));
  const [selected, setSelected] = useState(() => currentPath());
  const { tree, index: treeIndex, loading: treeLoading, error: treeError } = useFileTree(apiBase, selected, active);
  const bookmarkState = useBookmarks(active);
  const [document, setDocument] = useState(null);
  const [recentOnly, setRecentOnly] = useState(() => Boolean(initialSidebar.recentOnly));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const recentState = useRecentFiles(active, !error && document?.path === selected ? selected : null);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [search, setSearch] = useState('');
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [symbolSearch, setSymbolSearch] = useState('');
  const [bookmarkExpandedPaths, setBookmarkExpandedPaths] = useState({});
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const [readerStatus, setReaderStatus] = useState({ view: 'preview', line: null, page: null, pending: true });
  const activeView = document?.type === 'text' ? 'raw' : document?.type === 'binary' ? 'preview' : readerStatus.view;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 960px)').matches);
  const [filesVisible, setFilesVisible] = useState(() => initialSidebar.filesVisible ?? !matchMedia('(max-width: 960px)').matches);
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
  const symbolsScrollRef = useRef(null);
  const filesScrollTop = useRef(0);
  const restoreFilesScroll = useCallback(element => {
    filesScrollRef.current = element;
    if (element) element.scrollTop = filesScrollTop.current;
  }, []);
  const searchMode = sidebarTab === 'search';
  const readerRef = useRef(null);
  const [pathBarHidden, setPathBarHidden] = useState(true);
  const [copiedAction, setCopiedAction] = useState('');
  const [copyError, setCopyError] = useState('');
  const [openingDirectory, setOpeningDirectory] = useState(false);
  const [directoryOpenError, setDirectoryOpenError] = useState('');
  const [dark, setDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [toolbarStuck, setToolbarStuck] = useState(false);
  const toolbarRef = useRef(null);
  const toolbarSentinelRef = useRef(null);
  const mainPanelRef = useRef(null);

  useEffect(() => {
    setPathBarHidden(true);
  }, [document?.path, searchMode]);
  useEffect(() => {
    setReaderStatus(status => ({ view: status.view, line: null, page: null, pending: true }));
  }, [document?.path]);

  function reloadDocument() {
    readerRef.current?.capture();
    setDocumentRevision(value => value + 1);
  }

  function readerActivity(activity) {
    if (activity.kind === 'position') {
      setReaderStatus(status => ({ view: activity.view, pending: activity.pending,
        symbolId: activity.symbolId,
        line: activity.pending ? status.line : activity.line || null,
        page: activity.pending ? status.page : activity.page || null }));
    } else if (activity.kind === 'scroll') {
      setToolbarStuck(activity.top > 8);
      setPathBarHidden(activity.top > 2);
    }
  }

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
    const media = matchMedia('(max-width: 960px)');
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
    const client = crypto.randomUUID();
    const repo = repoId || '';
    const activity = () => {
      if (!window.document.hidden) fetch('/api/library/activity', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client }) }).catch(() => {});
    };
    const openDocument = event => {
      const request = parseDocumentOpenEvent(event);
      if (!request) return;
      readerRef.current?.capture();
      if (request.repo !== repo && repo) { syncReadingPositions().then(() => location.assign(request.url)).catch(cause => setError(String(cause))); return; }
      const target = new URL(request.url, location.origin);
      history.pushState(null, '', target.pathname + target.search);
      dispatchEvent(new PopStateEvent('popstate'));
      setDocumentRevision(value => value + 1);
      window.focus();
    };
    const stream = visibleEvents(`/api/library/session?${new URLSearchParams({ client, repo })}`, {
      connected: activity, 'document-open': openDocument, open: openDocument,
    }, { keepInBackground: true });
    addEventListener('focus', activity);
    window.document.addEventListener('visibilitychange', activity);
    return () => { stream.close(); removeEventListener('focus', activity);
      window.document.removeEventListener('visibilitychange', activity); };
  }, [repoId]);
  useEffect(() => {
    const pop = () => {
      // External open events also navigate background tabs. Route state must
      // follow the URL even while visibility-dependent watchers are paused.
      const kind = currentRouteKind();
      const params = new URLSearchParams(location.search);
      setGitPath(kind === 'git' ? params.get('path') : null);
      if (kind === 'git') setGitScope(params.get('scope') || 'unstaged');
      if (kind === 'search') setSearchConfig({ query: params.get('q') || '', scope: params.get('scope') || '' });
      readerRef.current?.capture();
      const path = currentPath();
      setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
      setSidebarTab(tab => kind === 'search' || kind === 'git' ? kind : ['search', 'git'].includes(tab) ? 'files' : tab);
      setReaderRequest(readerRouteRequest(path, location.search));
      setSelected(path);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useDocumentLease(apiBase, document?.path === selected ? selected : null);
  const selectedNode = treeIndex.get(selected);
  const selectedNodePath = selectedNode?.path;
  const selectedNodeType = selectedNode?.type;
  useEffect(() => {
    const name = selected.split('/').filter(Boolean).at(-1) || tree?.name || 'Notes';
    if (active) window.document.title = name;
  }, [selected, tree?.name, active]);
  const loadedDocumentRequest = useRef(null);
  const documentView = document?.path === selected ? activeView
    : readerRequest?.path === selected ? readerRequest.view : null;
  useEffect(() => {
    if (!active) { loadedDocumentRequest.current = null; return; }
    if (!tree) return;
    if (selected && !selectedNode) {
      if (treeLoading) { setLoading(true); setDocument(null); setError(''); return; }
      setLoading(false);
      setError('File not found in the notes library');
      setDocument(null);
      return;
    }
    if (!selectedNode || selectedNode.type === 'directory') { setLoading(false); setDocument(null); setError(''); return; }
    const loadKey = JSON.stringify([selected, selectedNodePath, selectedNodeType, documentRevision, dark]);
    const hasRequestedContent = document?.path === selected && (documentView === 'raw'
      || (document.type === 'markdown' ? typeof document.html === 'string'
        : document.type === 'typst' ? Boolean(document.compile) : true));
    if (loadedDocumentRequest.current === loadKey && hasRequestedContent) {
      setLoading(false); setError(''); return;
    }
    const controller = new AbortController();
    if (document?.path === selected && document.type === 'typst') readerRef.current?.capture();
    setLoading(true);
    if (document?.path !== selected) setDocument(null);
    setError('');
    let fetchedView = documentView;
    const fetchDocument = async () => {
      const view = documentView || (await loadPosition(readingKey(pageBase, selected), apiBase, selected)).view || 'preview';
      fetchedView = view;
      controller.signal.throwIfAborted();
      return fetch(`${apiBase}/document?${new URLSearchParams({ path: selected, view, theme: dark ? 'dark' : 'light' })}`,
        { signal: controller.signal });
    };
    fetchDocument().then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }).then(async value => {
      if (controller.signal.aborted) return;
      loadedDocumentRequest.current = loadKey;
      if (document?.path === value.path && document.modified === value.modified
        && document.compile?.id === value.compile?.id && document.html === value.html) return;
      if (document?.path !== value.path) setReaderStatus({ view: fetchedView, line: null, page: null, pending: true });
      setDocument(value);
    })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, selected, selectedNodePath, selectedNodeType, documentRevision, documentView, dark, selected && !selectedNode && treeLoading]);
  function navigate(path, directory = false, line = null) {
    readerRef.current?.capture();
    setGitPath(null);
    setSidebarTab(tab => tab === 'search' ? 'files' : tab);
    setReaderRequest({ path, line, view: line ? 'raw' : null });
    history.pushState(null, '', noteUrl(path, directory) + (line ? `?line=${line}#L${line}` : ''));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    if (matchMedia('(max-width: 960px)').matches) setFilesVisible(false);
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
  const currentSymbol = activeSymbolId(symbols, readerStatus);
  useLayoutEffect(() => {
    if (sidebarTab !== 'symbols' || !filesVisible || !currentSymbol) return;
    const panel = symbolsScrollRef.current;
    revealSymbolVertically(panel, panel?.querySelector('[aria-current="location"]'));
  }, [currentSymbol, sidebarTab, filesVisible, symbolSearch]);

  function jumpToSymbol(symbol) {
    setReaderRequest({ path: selected, symbol, view: activeView });
    if (searchMode) {
      setGitPath(null);
      setSidebarTab('files');
      const suffix = symbol.line
        ? `?line=${symbol.line}&view=${activeView}#L${symbol.line}`
        : symbol.page ? `#page=${symbol.page}` : '';
      history.pushState(null, '', noteUrl(selected) + suffix);
    }
    if (narrow) setFilesVisible(false);
  }
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
    readerRef.current?.capture();
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
              readerRef.current?.capture();
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
          </div><nav ref={symbolsScrollRef} className="symbols-list tree-scroll" aria-label="Document symbols">{filteredSymbols.length ?
            <ActionList variant="full">{filteredSymbols.map(symbol => <ActionList.Item key={symbol.id}
              active={symbol.id === currentSymbol} aria-current={symbol.id === currentSymbol ? 'location' : undefined}
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
        {narrow && filesVisible && <SideSheet title="Sidebar" className="sidebar-drawer"
          position="left" width={`min(calc(44px + ${sidebarWidth + 80}px + 6px), calc(100vw - 32px))`} returnFocusRef={sidebarToggleRef}
          onClose={() => setFilesVisible(false)}
          renderHeader={({ dialogLabelId }) => <div className="sidebar-drawer-header">
            <span className="visually-hidden" id={dialogLabelId}>Sidebar</span>
            </div>}
          renderBody={() => <><nav className="sidebar-rail" aria-label="Sidebar views">
            {sidebarViews.map(view => <IconButton key={view.id} size="medium" variant="invisible"
              className={`sidebar-rail-button${view.id === 'repos' ? ' sidebar-rail-repos' : ''}`} icon={view.icon} aria-label={view.label}
              title={view.label} tooltipDirection="e" aria-pressed={filesVisible && sidebarViewSelected(view.id)}
              aria-controls="sidebar-content" onClick={() => selectSidebarView(view.id, false)} />)}
          </nav><div className="sidebar sidebar-drawer-content" id="sidebar-content">{sidebarContent}</div></>} />}
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
        <main className={`main-panel${gitPath === null && !searchMode && !error && activeView === 'preview' && hasDocumentViewport(document) ? ' has-document-viewport' : ''}${gitPath === null && !searchMode && !error && document && pathBarHidden ? ' path-bar-hidden' : ''}`} ref={mainPanelRef}>
          <div className="page-header" inert={gitPath === null && !searchMode && !error && document && pathBarHidden ? true : undefined}>
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
                    aria-selected={activeView === 'preview'} onClick={() => readerRef.current?.switchView('preview')}>Preview</button>}
                  {!['image', 'pdf', 'binary'].includes(document.type) && <button className={`file-tab ${activeView === 'raw' ? 'selected' : ''}`} role="tab"
                    aria-selected={activeView === 'raw'} onClick={() => readerRef.current?.switchView('raw')}>Raw</button>}
                </div>
                <span className="file-current-line" aria-busy={document.lineCount != null && readerStatus.pending}>
                  {document.lineCount != null && <>{`${readerStatus.line ?? '—'} / ${document.lineCount} lines · `}</>}
                  {sizeLabel(document.size)}
                  {document.modified && <>{' · '}<time dateTime={document.modified} title={formatModified(document.modified)}>
                    {formatRelativeModified(document.modified)}
                  </time></>}
                </span>
                <div className="toolbar-actions" role="group" aria-label="Page actions">
                  {toolbarStuck && <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
                    title="Back to top" onClick={() => readerRef.current?.toTop()} />}
                  {toolbarStuck && activeView === 'preview' && hasDocumentViewport(document) && <IconButton
                    size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Fit and recenter page"
                    title="Fit and recenter page" onClick={() => readerRef.current?.fit()} />}
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
              <Reader ref={readerRef} key={document.path} document={document} request={readerRequest}
                navigate={navigate} onReload={reloadDocument} onActivity={readerActivity} />
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles></ThemeProvider>;
}

createRoot(document.getElementById('root')).render(<BrowserSession><App /></BrowserSession>);
