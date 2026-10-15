import { useDocumentLease } from './document-session.jsx';
import { BrowserSession, SessionActivity } from './session-activity.jsx';
import { HISTORY_GROUPS } from './time-labels.mjs';
import { visibleEvents } from './visible-events.mjs';
import { parseDocumentOpenEvent } from './session-events.mjs';
import { sortFileTree, fileTreeForView } from './file-tree.mjs';
import { useFileTree } from './use-file-tree.jsx';
import { apiBase, pageBase, repoId, routeKind, fileUrl } from './urls.mjs';
import { searchUrl, gitUrl, parseRepositoryLocation } from '../shared/paths.mjs';
import React, { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, Breadcrumbs, IconButton, Spinner } from '@primer/react';
import { Dialog as SideSheet } from '@primer/react/experimental';
import { SearchInput } from './search-input.jsx';
import { FocusCenterIcon, SortDescIcon, FoldIcon, FileDirectoryIcon, SearchIcon, SidebarExpandIcon, ListUnorderedIcon, RepoIcon, GitBranchIcon, BookmarkIcon, HistoryIcon } from '@primer/octicons-react';
import { useBookmarks } from './bookmarks.jsx';
import { RecentFiles, useRecentFiles } from './recent-files.jsx';
import { RepoPicker } from './repo-picker.jsx';
import { useWorkspaceSearch } from './workspace-search.jsx';
import { useGitStatus } from './use-git-status.jsx';
import { readSidebarState, saveSidebarState } from './sidebar-state.mjs';
import { Reader } from './reader.jsx';
import { hasDocumentViewport } from './preview-kind.mjs';
import { syncReadingPositions, loadPosition, readingKey } from './reading-state.mjs';
import { readerRouteRequest } from './reader-session.mjs';
import { randomId } from './random-id.mjs';
import { FileTree } from './file-tree-view.jsx';
import { documentSymbols, SymbolsPanel } from './symbols-panel.jsx';
import { DocumentToolbar } from './document-toolbar.jsx';
import { DirectoryView } from './directory-view.jsx';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/base/motion/motion.css';
import './markdown/theme.css';
import './markdown/heading-sections.css';
import './markdown/highlight.css';
import './markdown/footnotes.css';
import 'katex/dist/katex.min.css';
import 'markdown-it-texmath/css/texmath.css';
import './theme.css';
import '../shared/image-theme.css';
import { ThemeProvider, useTheme } from '@primer/react/next';
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


function currentRouteKind() { return parseRepositoryLocation(location.pathname)?.kind || null; }
function currentPath() {
  const route = parseRepositoryLocation(location.pathname);
  return route?.kind === 'tree' ? route.path : route?.kind === 'search' ? new URLSearchParams(location.search).get('file') || '' : '';
}
function expandedPathEntries(path) {
  const entries = {};
  const parts = path.split('/').filter(Boolean);
  for (let index = 0; index < parts.length; index++) entries[parts.slice(0, index + 1).join('/')] = true;
  return entries;
}

function LibraryError({ error, path, navigate }) {
  const detail = error instanceof Error ? error.message : String(error || 'Unknown error');
  const missing = /not found|does not exist|enoent/i.test(detail);
  const parent = path?.split('/').slice(0, -1).join('/') || '';
  return <section className="status error library-error" role="alert">
    <div>
      <h2>{missing ? 'File not found' : 'Could not load this content'}</h2>
      <p>{missing ? <>
        This file may have been moved, renamed, or deleted. <a className="error-inline-link" href={fileUrl(parent, true)}
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
  const [bookmarkExpandedPaths, setBookmarkExpandedPaths] = useState({});
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const [readerStatus, setReaderStatus] = useState({ view: 'preview', line: null, page: null, pending: true });
  const activeView = document?.type === 'text' ? 'raw' : document?.type === 'binary' ? 'preview' : readerStatus.view;
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 960px)').matches);
  const [filesVisible, setFilesVisible] = useState(() => initialSidebar.filesVisible ?? !narrow);
  const sidebarToggleRef = useRef(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => initialSidebar.sidebarWidth ?? 245);
  const [sidebarTab, setSidebarTab] = useState(() => ['search', 'git'].includes(routeKind) ? routeKind
    : initialSidebar.sidebarTab || 'files');
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
  const readerRef = useRef(null);
  const [pathBarHidden, setPathBarHidden] = useState(true);
  const { colorScheme: theme } = useTheme();
  const [toolbarStuck, setToolbarStuck] = useState(false);
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
  }
  function startSidebarResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeSidebar(event);
  }

  useEffect(() => {
    const media = matchMedia('(max-width: 960px)');
    const update = event => { setNarrow(event.matches); setFilesVisible(!event.matches); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
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
    const client = randomId();
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
    if (selected && !selectedNode && treeLoading) {
      setLoading(true); setDocument(null); setError(''); return;
    }
    // Ignored files found through gitignore:no or a direct URL need not be in
    // the visible tree. The document endpoint validates existence and access.
    if (!selected || selectedNode?.type === 'directory') { setLoading(false); setDocument(null); setError(''); return; }
    const loadKey = JSON.stringify([selected, selectedNodePath, selectedNodeType, documentRevision, theme]);
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
      return fetch(`${apiBase}/document?${new URLSearchParams({ path: selected, view, theme })}`,
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
  }, [active, selected, selectedNodePath, selectedNodeType, documentRevision, documentView, theme, selected && !selectedNode && treeLoading]);
  function navigate(path, directory = false, line = null) {
    readerRef.current?.capture();
    setGitPath(null);
    setSidebarTab(tab => tab === 'search' ? 'files' : tab);
    setReaderRequest({ path, line, view: line ? 'raw' : null });
    history.pushState(null, '', fileUrl(path, directory) + (line ? `?line=${line}#L${line}` : ''));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    if (narrow) setFilesVisible(false);
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
    const row = item.querySelector('.file-tree-link[aria-current="page"]');
    if (!row) return;
    panel.scrollTop += row.getBoundingClientRect().top - panel.getBoundingClientRect().top
      - (panel.clientHeight - row.getBoundingClientRect().height) / 2;
    filesScrollTop.current = panel.scrollTop;
  }, [locateRequest]);
  const symbols = useMemo(() => document ? documentSymbols(document) : [], [document]);

  function jumpToSymbol(symbol) {
    setReaderRequest({ path: selected, symbol, view: activeView });
    if (searchMode) {
      setGitPath(null);
      setSidebarTab('files');
      const suffix = symbol.line
        ? `?line=${symbol.line}&view=${activeView}#L${symbol.line}`
        : symbol.page ? `#page=${symbol.page}` : '';
      history.pushState(null, '', fileUrl(selected) + suffix);
    }
    if (narrow) setFilesVisible(false);
  }
  const codeSearch = useWorkspaceSearch({ config: searchConfig, onConfig: config => {
    setSearchConfig(config);
    if (currentRouteKind() === 'search') history.replaceState(null, '', searchUrl(repoId, config.query, config.scope, selected));
  }, navigate, active: active && searchMode,
    currentFile: selected, scrollRef: mainPanelRef, treeIndex, bookmarks: bookmarkState.bookmarks,
    symbols, onSelectSymbol: jumpToSymbol });
  function selectSidebarView(id, collapse = true) {
    readerRef.current?.capture();
    if (id === 'bookmarks' && sidebarTab !== 'bookmarks') setBookmarkExpandedPaths({});
    if (id === 'search' && currentRouteKind() !== 'search') history.pushState(null, '', searchUrl(repoId, searchConfig.query, searchConfig.scope, selected));
    else if (id === 'git' && currentRouteKind() !== 'git') history.pushState(null, '', gitUrl(repoId, gitPath || '', gitScope));
    else if (!['search', 'git'].includes(id) && ['search', 'git'].includes(currentRouteKind())) {
      history.pushState(null, '', fileUrl(selected));
      setGitPath(null);
    }
    setFilesVisible(!collapse || !(filesVisible && sidebarTab === id));
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
            onScroll={event => { filesScrollTop.current = event.currentTarget.scrollTop; }}>{!bookmarksOnly && recentOnly ? <RecentFiles state={recentState} renderTree={nodes => <FileTree nodes={nodes} label="Browsing history"
              selected={selected} navigate={navigate} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />} /> : bookmarksOnly && bookmarkState.loading ? <div className="tree-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading bookmarks</span></div> : tree ? filteredTree.length ? <FileTree nodes={filteredTree} label={bookmarksOnly ? 'Bookmarked files tree' : 'Notes tree'}
            selected={selected} navigate={navigate} searching={Boolean((bookmarksOnly ? bookmarkSearch : search).trim())}
            defaultExpanded={bookmarksOnly} expandedPaths={bookmarksOnly ? bookmarkExpandedPaths : expandedPaths}
            setExpandedPaths={bookmarksOnly ? setBookmarkExpandedPaths : setExpandedPaths}
            bookmarkState={bookmarksOnly ? bookmarkState : undefined} /> : <div className="tree-empty">{bookmarksOnly ? bookmarkSearch.trim() ? 'No matching bookmarks' : bookmarkState.bookmarks.length ? 'No bookmarked files available' : 'Open a file to add a bookmark.' : 'No matching files'}</div> : treeLoading ? <div className="tree-loading"><Spinner size="small" /></div> : null}</div>
          </> : null}
    <SymbolsPanel symbols={symbols} status={readerStatus} onSelect={jumpToSymbol}
      hidden={sidebarTab !== 'symbols'} visible={filesVisible} />
  </>;
  return <BaseStyles>
    <div className={`app-shell ${filesVisible ? '' : 'files-hidden'}`}>
      <div className="workspace" style={{ '--sidebar-width': `${sidebarWidth}px` }}>
        {!narrow && <nav className="sidebar-rail" aria-label="Sidebar views">
          {sidebarViews.map(view => <IconButton key={view.id} size="medium" variant="invisible"
            className={`sidebar-rail-button${view.id === 'repos' ? ' sidebar-rail-repos' : ''}`} icon={view.icon} aria-label={view.label} tooltipDirection="e"
            aria-pressed={filesVisible && sidebarTab === view.id} aria-controls="sidebar-content"
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
              title={view.label} tooltipDirection="e" aria-pressed={filesVisible && sidebarTab === view.id}
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
          }} />
        <main className={`main-panel${gitPath === null && !searchMode && !error && activeView === 'preview' && hasDocumentViewport(document) ? ' has-document-viewport' : ''}${gitPath === null && !searchMode && !error && document && pathBarHidden ? ' path-bar-hidden' : ''}`} ref={mainPanelRef}>
          <div className="page-header" inert={gitPath === null && !searchMode && !error && document && pathBarHidden ? true : undefined}>
            <div className="path-row">
              <Breadcrumbs>
                <Breadcrumbs.Item href={`${pageBase}/`} onClick={event => { event.preventDefault(); navigate(''); }}>{tree?.name || 'Notes'}</Breadcrumbs.Item>
                {searchMode ? <Breadcrumbs.Item selected>Search</Breadcrumbs.Item> : parts.map((part, index) => <Breadcrumbs.Item key={index} href={fileUrl(parts.slice(0, index + 1).join('/'))}
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
              onClose={() => { history.pushState(null, '', fileUrl(selected)); setGitPath(null); }} />
          </Suspense>}
          <div className="content-panel" hidden={searchMode || gitPath !== null}>
            {bookmarkState.error && !bookmarksOnly && <div className="action-error" role="alert">{bookmarkState.error}</div>}
            {loading && !document && <div className="status" role="status"><span className="rendering-label">Rendering</span></div>}
            {!loading && error && <LibraryError error={error} path={selected} navigate={navigate} />}
            {!loading && !error && entries && <DirectoryView key={selected} directory={selectedNode || tree} navigate={navigate} />}
            {!error && document && <>
              <DocumentToolbar key={document.path} document={document} status={{ ...readerStatus, view: activeView }}
                stuck={toolbarStuck} readerRef={readerRef} sentinelRef={toolbarSentinelRef} bookmarkState={bookmarkState}
                sidebarToggle={narrow && <IconButton ref={sidebarToggleRef} hidden={filesVisible} size="small" variant="invisible"
                  className="sidebar-toggle" icon={SidebarExpandIcon} aria-label="Show sidebar" title="Show sidebar"
                  aria-expanded={filesVisible} aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />} />
              <Reader ref={readerRef} key={document.path} document={document} request={readerRequest}
                navigate={navigate} onReload={reloadDocument} onActivity={readerActivity} />
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles>;
}

createRoot(document.getElementById('root')).render(<ThemeProvider colorMode="auto" contextOnly><BrowserSession><App /></BrowserSession></ThemeProvider>);
