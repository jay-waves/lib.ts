import { IconButton } from '@primer/react';
import { useDocumentLease } from './use-document-lease';
import { BrowserSession, SessionActivity } from './session-activity';
import { HISTORY_GROUPS } from './time-labels.mjs';
import { visibleEvents } from './visible-events.mjs';
import { parseDocumentOpenEvent } from './session-events.mjs';
import { sortFileTree, fileTreeForView } from './file-tree.mjs';
import { useFileTree } from './use-file-tree';
import { apiBase, pageBase, repoId, routeKind, fileUrl } from './urls.mjs';
import { searchUrl, gitUrl, parseRepositoryLocation } from './paths.ts';
import React, { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, Button, Spinner } from '@primer/react';
import { Dialog as SideSheet } from '@primer/react/experimental';
import { FocusCenterIcon, SortDescIcon, FoldIcon, FileDirectoryIcon, SearchIcon, SidebarExpandIcon, ListUnorderedIcon, RepoIcon, GitBranchIcon, BookmarkIcon, HistoryIcon } from '@primer/octicons-react';
import { useBookmarks } from './bookmarks';
import { RecentFiles, useRecentFiles } from './recent-files';
import { RepoPicker } from './repo-picker';
import { PathBar } from './path-bar';
import { useWorkspaceSearch } from './workspace-search.tsx';
import { useGitStatus } from './use-git-status.tsx';
import { readSidebarState, saveSidebarState } from './sidebar-state.mjs';
import { readRepositoryDisplayState, saveRepositoryDisplayState } from './directory-state.mjs';
import { Reader } from './reader.jsx';
import { hasDocumentViewport } from './preview-kind.mjs';
import { syncReadingPositions } from './reading-state.mjs';
import { useDocument } from './use-document.ts';
import { readerRouteRequest } from './reader-session.mjs';
import { randomId } from './random-id.mjs';
import { FileTree } from './file-tree-view.tsx';
import { BookmarkList } from './bookmark-list';
import { documentSymbols, SymbolsPanel } from './symbols-panel.tsx';
import { useMediaDimensions } from './use-media-dimensions';
import { DocumentToolbar } from './document-toolbar.tsx';
import { DirectoryView } from './directory-view.tsx';
import { useToolbarStuck } from './file-toolbar';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import '@primer/primitives/dist/css/base/motion/motion.css';
import './markdown/theme.css';
import './markdown/heading-sections.css';
import './markdown/highlight.css';
import './markdown/footnotes.css';
import 'katex/dist/katex.min.css';
import './theme.css';
import './image-theme.css';
import { ThemeProvider, useTheme } from '@primer/react/next';
import './style.css';
import './sidebar.css';
import './tailwind.css';

const GitPanel = lazy(() => import('./git-panel.tsx'));
const GitDiffView = lazy(() => import('./git-diff-view'));

const sidebarViews = [
  { id: 'files', label: 'Files', icon: FileDirectoryIcon },
  { id: 'search', label: 'Search', icon: SearchIcon },
  { id: 'symbols', label: 'Symbols', icon: ListUnorderedIcon },
  { id: 'bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
  { id: 'git', label: 'Git', icon: GitBranchIcon },
  { id: 'repos', label: 'Repos', icon: RepoIcon },
];


function SidebarRail({ visible, selected, onSelect, drawer = false }) {
  return <nav className="sidebar-rail col-start-1 row-start-1 flex w-sidebar-rail flex-none box-border flex-col items-center gap-3 border-0 border-e border-solid border-divider bg-subtle px-1 pt-3 pb-sidebar-top" aria-label="Sidebar views">
    {sidebarViews.map(view => <IconButton unsafeDisableTooltip key={view.id} size="medium" variant="invisible"
      className={`relative size-10! text-muted! [&_svg]:size-6! aria-pressed:bg-selected! aria-pressed:text-fg!${view.id === 'repos' ? ' mt-auto' : ''}`}
      icon={props => <view.icon {...props} size={24} stroke="currentColor" strokeWidth={0.3} strokeLinejoin="round" />} aria-label={view.label}
      aria-pressed={visible && selected === view.id} aria-controls="sidebar-content"
      onClick={() => onSelect(view.id, !drawer)} />)}
  </nav>;
}

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
  const [display, setDisplay] = useState(() => readRepositoryDisplayState(pageBase));
  const changeDisplay = patch => {
    setDisplay(previous => ({ ...previous, ...patch }));
    saveRepositoryDisplayState(pageBase, patch);
    if (patch.showHidden === false) {
      const parts = selected.split('/');
      const hidden = parts.findIndex(part => part.startsWith('.'));
      if (hidden >= 0) navigate(parts.slice(0, hidden).join('/'), true);
    }
  };
  const { tree, index: treeIndex, loading: treeLoading, error: treeError } = useFileTree(apiBase, selected, active, display.showHidden === true);
  const bookmarkState = useBookmarks(active && Boolean(apiBase));
  const [recentOnly, setRecentOnly] = useState(() => Boolean(initialSidebar.recentOnly));
  const [documentRevision, setDocumentRevision] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const [readerStatus, setReaderStatus] = useState({ view: 'preview', line: null, page: null, pending: true });
  const readerRef = useRef(null);
  const { colorScheme: theme } = useTheme();
  const selectedNode = treeIndex.get(selected);
  const { document, loading, error, setError } = useDocument({
    apiBase, pageBase, path: selected, active, treeReady: Boolean(tree), treeLoading,
    node: selectedNode, revision: documentRevision, theme, view: readerStatus.view, request: readerRequest,
    capture: () => readerRef.current?.capture(),
    onOpen: view => setReaderStatus({ view, line: null, page: null, pending: true }),
  });
  const mediaDimensions = useMediaDimensions(document);
  const recentState = useRecentFiles(active && Boolean(apiBase), document?.path === selected ? selected : null);
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
  const gitState = useGitStatus(Boolean(apiBase) && active && ((sidebarTab === 'git' && filesVisible) || (gitPath !== null && sidebarTab !== 'search')));
  const [sortMode, setSortMode] = useState(() => initialSidebar.sortMode || 'name');
  const nextSortMode = { name: 'modified', modified: 'name' }[sortMode];
  const sortLabels = { name: 'name', modified: 'modified time (newest first)' };
  const sortTitle = `Sorted by ${sortLabels[sortMode]}; click to sort by ${sortLabels[nextSortMode]}`;
  const [locateRequest, setLocateRequest] = useState(0);
  useEffect(() => {
    if (active) saveSidebarState(apiBase, { sidebarTab, filesVisible, sidebarWidth, bookmarksOnly, recentOnly, sortMode });
  }, [active, sidebarTab, filesVisible, sidebarWidth, bookmarksOnly, recentOnly, sortMode]);
  const filesScrollRef = useRef(null);
  const filesScrollTop = useRef(0);
  const restoreFilesScroll = useCallback(element => {
    filesScrollRef.current = element;
    if (element) element.scrollTop = filesScrollTop.current;
  }, []);
  const searchMode = sidebarTab === 'search';
  const { stuck: toolbarStuck, sentinelRef: toolbarSentinelRef } = useToolbarStuck(!searchMode && gitPath === null && Boolean(document));
  const mainPanelRef = useRef(null);

  useEffect(() => {
    setReaderStatus(status => ({ view: status.view, line: null, page: null, pending: true }));
  }, [document?.path]);

  function reloadDocument() {
    setDocumentRevision(value => value + 1);
  }

  function readerActivity(activity) {
    if (activity.kind === 'position') {
      setReaderStatus(status => ({ view: activity.view, pending: activity.pending,
        symbolId: activity.symbolId, bookmarkPage: activity.bookmarkPage,
        line: activity.pending ? status.line : activity.line || null,
        page: activity.pending ? status.page : activity.page || null }));
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
    if (!repoId) return;
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
  useDocumentLease(apiBase, apiBase && document?.path === selected ? selected : null);
  useEffect(() => {
    const name = selected.split('/').filter(Boolean).at(-1) || tree?.name || 'Notes';
    if (active) window.document.title = name;
  }, [selected, tree?.name, active]);
  function navigate(path, directory = false, line = null, page = null) {
    readerRef.current?.capture();
    setGitPath(null);
    setSidebarTab(tab => tab === 'search' ? 'files' : tab);
    setReaderRequest({ path, line, page, view: line ? 'raw' : null });
    history.pushState(null, '', fileUrl(path, directory) + (page ? `?page=${page.index + 1}&x=${page.x}&y=${page.y}` : line ? `?line=${line}#L${line}` : ''));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    if (narrow) setFilesVisible(false);
    if (directory) setSidebarTab('files');
  }
  const parts = (gitPath ?? selected).split('/').filter(Boolean);
  const entries = selectedNode?.type === 'directory' ? selectedNode.children ?? [] : !selected ? tree?.children : null;
  const filteredTree = useMemo(() => {
    const nodes = sortMode === 'name' ? tree?.children : sortFileTree(tree?.children);
    return fileTreeForView(nodes, { bookmarksOnly, bookmarks: bookmarkState.bookmarks });
  }, [tree, sortMode, bookmarksOnly, bookmarkState.bookmarks]);
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
  }, navigate, active: active && Boolean(apiBase) && searchMode,
    currentFile: selected, scrollRef: mainPanelRef, treeIndex, bookmarks: bookmarkState.bookmarks,
    symbols, onSelectSymbol: jumpToSymbol });
  function selectSidebarView(id, collapse = true, searchScope) {
    readerRef.current?.capture();
    if (id === 'search' && searchScope !== undefined) setSearchConfig(config => ({ ...config, scope: searchScope }));
    if (id === 'search' && currentRouteKind() !== 'search') history.pushState(null, '', searchUrl(repoId, searchConfig.query, searchScope ?? searchConfig.scope, selected));
    else if (id === 'git' && currentRouteKind() !== 'git') history.pushState(null, '', gitUrl(repoId, gitPath || '', gitScope));
    else if (!['search', 'git'].includes(id) && ['search', 'git'].includes(currentRouteKind())) {
      history.pushState(null, '', fileUrl(selected));
      setGitPath(null);
    }
    setFilesVisible(!collapse || !(filesVisible && sidebarTab === id));
    setSidebarTab(id);
  }
  const sidebarContent = <>
          {sidebarTab === 'git' && filesVisible && active && <Suspense fallback={<div className="sidebar-loading"><Spinner size="small" /></div>}>
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
          {!bookmarksOnly && <div className="relative flex min-h-toolbar flex-none box-border items-center justify-center border-0 border-b border-solid border-divider px-[clamp(24px,12%,36px)] py-1 [&_button]:flex-none [&_button]:text-muted! [&_button[aria-pressed=true]]:bg-selected! [&_button[aria-pressed=true]]:text-accent!" role="toolbar" aria-label="File tree actions">
            <div className="flex w-full flex-wrap items-center justify-between gap-y-2">
            <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={HistoryIcon}
              aria-label={recentOnly ? 'Show all files' : 'Recent Files'}
              aria-pressed={recentOnly} onClick={() => setRecentOnly(value => !value)} />
            <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={FoldIcon} aria-label="Collapse all folders"
              disabled={recentOnly ? !HISTORY_GROUPS.some(group => expandedPaths[`history:${group.id}`] !== false)
                : !Object.values(expandedPaths).some(Boolean)}
              onClick={() => setExpandedPaths(recentOnly ? Object.fromEntries(HISTORY_GROUPS.map(group => [`history:${group.id}`, false])) : {})} />
            <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Locate current file" disabled={!selectedNode}
              onClick={() => {
                setRecentOnly(false);
                setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(selected) }));
                setLocateRequest(value => value + 1);
              }} />
            <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={SortDescIcon} aria-label={sortTitle}
              disabled={recentOnly}
              onClick={() => setSortMode(nextSortMode)} />
            <IconButton unsafeDisableTooltip
              size="small" variant="invisible" icon={SearchIcon} aria-label="Search"
              onClick={() => selectSidebarView('search', false, 'files')} />
            </div>
          </div>}
          {bookmarksOnly && bookmarkState.error && <div className="action-error" role="alert">{bookmarkState.error}</div>}
          {treeError && <div className="action-error" role="alert">{treeError}</div>}
          <div className="sidebar-scroll files-scroll" ref={restoreFilesScroll}
            onScroll={event => { filesScrollTop.current = event.currentTarget.scrollTop; }}>{!bookmarksOnly && recentOnly ? <RecentFiles state={recentState} renderTree={nodes => <FileTree nodes={nodes} label="Browsing history"
              selected={selected} navigate={navigate} expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />} /> : bookmarksOnly && bookmarkState.loading ? <div className="sidebar-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading bookmarks</span></div> : tree ? filteredTree.length ? bookmarksOnly
            ? <BookmarkList files={filteredTree} bookmarks={bookmarkState.bookmarks} selected={selected} request={readerRequest} navigate={navigate} />
            : <FileTree nodes={filteredTree} label="Notes tree" selected={selected} navigate={navigate}
              expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} />
            : <div className="sidebar-empty">{bookmarksOnly ? bookmarkState.bookmarks.length ? 'No bookmarked files available' : 'Open a file to add a bookmark.' : 'No matching files'}</div> : treeLoading ? <div className="sidebar-loading"><Spinner size="small" /></div> : null}</div>
          </> : null}
    <SymbolsPanel symbols={symbols} status={readerStatus} onSelect={jumpToSymbol}
      hidden={sidebarTab !== 'symbols'} visible={filesVisible} />
  </>;
  return <BaseStyles>
    <div className={`app-shell h-dvh min-h-0 w-full overflow-hidden ${filesVisible ? '' : 'files-hidden'}`}>
      <div className="workspace grid size-full min-h-0 grid-cols-[var(--spacing-sidebar-rail)_var(--sidebar-width,245px)_6px_minmax(0,1fr)] overflow-hidden" style={{ '--sidebar-width': `${sidebarWidth}px` }}>
        {!narrow && <SidebarRail visible={filesVisible} selected={sidebarTab} onSelect={selectSidebarView} />}
        {!narrow && <aside className="sidebar sidebar-panel" id="sidebar-content" aria-label="Sidebar">
          {sidebarContent}
        </aside>}
        {narrow && filesVisible && <SideSheet title="Sidebar" className="sidebar-drawer"
          position="left" width={`min(calc(var(--spacing-sidebar-rail) + ${sidebarWidth + 80}px + 6px), calc(100vw - 32px))`} returnFocusRef={sidebarToggleRef}
          onClose={() => setFilesVisible(false)}
          renderHeader={({ dialogLabelId }) => <div className="sidebar-drawer-header flex-none">
            <span className="visually-hidden" id={dialogLabelId}>Sidebar</span>
            </div>}
          renderBody={() => <>
            <SidebarRail visible={filesVisible} selected={sidebarTab} onSelect={selectSidebarView} drawer />
            <div className="sidebar sidebar-panel w-auto flex-1" id="sidebar-content">{sidebarContent}</div>
          </>} />}
        <div className="sidebar-resize relative col-start-3 row-start-1 z-2 cursor-col-resize touch-none bg-surface outline-none" role="separator" aria-orientation="vertical" aria-label="Resize sidebar"
          aria-valuemin={180} aria-valuemax={480} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0}
          onPointerDown={startSidebarResize} onPointerMove={event => { if (event.buttons === 1) resizeSidebar(event); }}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const width = Math.max(180, Math.min(480, sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10)));
            setSidebarWidth(width);
          }} />
        <main className={`main-panel col-start-4 row-start-1 h-dvh max-h-dvh min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-none bg-surface${gitPath === null && !searchMode && activeView === 'preview' && hasDocumentViewport(document) ? ' document-viewport' : ''}`} ref={mainPanelRef} tabIndex={0}
          onKeyDown={event => {
            if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target;
            if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a[href], [role="button"]'))) return;
            if (searchMode || gitPath !== null || !document) return;
            event.preventDefault();
            const video = document.type === 'binary' && mainPanelRef.current?.querySelector('video');
            if (video) {
              if (video.paused) video.play().catch(() => {});
              else video.pause();
              return;
            }
            if (activeView === 'raw' || ['pdf', 'typst', 'markdown', 'html', 'image'].includes(document.type))
              mainPanelRef.current?.scrollBy({ top: mainPanelRef.current.clientHeight * 0.9, behavior: 'smooth' });
          }}>
          {(!searchMode || narrow) && <div className="page-header mx-auto flex h-toolbar min-h-0 w-[var(--content-width)] flex-none box-border items-center gap-2 p-0 text-ui">
            <div className="flex min-w-0 flex-1 items-center justify-between gap-2.5 [&>nav]:min-w-0 [&>nav]:flex-auto [&>nav]:overflow-hidden">
              {!searchMode && <PathBar items={[
                { label: tree?.name || 'Notes', path: '', href: `${pageBase}/` },
                ...parts.map((label, index) => {
                  const path = parts.slice(0, index + 1).join('/');
                  return { label, path, href: fileUrl(path) };
                }),
              ]} onNavigate={path => navigate(path)} />}
              <div className="ms-auto flex flex-none items-center gap-1">
                {narrow && (gitPath !== null || searchMode || !document) && <IconButton unsafeDisableTooltip ref={sidebarToggleRef} hidden={filesVisible}
                  size="small" variant="invisible" className="sidebar-toggle" icon={SidebarExpandIcon}
                  aria-label="Show sidebar" aria-expanded={filesVisible}
                  aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />}
              </div>
            </div>
          </div>}
          {searchMode && codeSearch.results}
          {!searchMode && gitPath !== null && <Suspense fallback={<div className="status"><Spinner /> Loading diff…</div>}>
            <GitDiffView key={`${gitScope}:${gitPath}`} path={gitPath} scope={gitScope} active={active} revision={gitState.updatedAt}
              onOpen={treeIndex.has(gitPath) ? () => navigate(gitPath) : undefined}
              onClose={() => { history.pushState(null, '', fileUrl(selected)); setGitPath(null); }} />
          </Suspense>}
          <div className="content-panel ui-panel" hidden={searchMode || gitPath !== null}>
            {!repoId && <div className="status empty-repository" role="status">
              <p>No repository is open.</p>
              <Button size="small" onClick={() => { setSidebarTab('repos'); setFilesVisible(true); }}>Add a repository</Button>
            </div>}
            {Boolean(repoId) && <>
            {bookmarkState.error && !bookmarksOnly && <div className="action-error" role="alert">{bookmarkState.error}</div>}
            {loading && !document && <div className="status" role="status"><span className="rendering-label">Rendering</span></div>}
            {!loading && error && (document ? <div className="action-error" role="alert">{error}</div>
              : <LibraryError error={error} path={selected} navigate={navigate} />)}
            {!loading && !error && entries && <DirectoryView key={selected} directory={selectedNode || tree} navigate={navigate}
              display={display} onDisplayChange={changeDisplay} />}
            {document && <>
              <DocumentToolbar key={document.path} document={document} dimensions={mediaDimensions.dimensions} status={{ ...readerStatus, view: activeView }}
                stuck={toolbarStuck} readerRef={readerRef} sentinelRef={toolbarSentinelRef} bookmarkState={bookmarkState}
                sidebarToggle={narrow && <IconButton unsafeDisableTooltip ref={sidebarToggleRef} hidden={filesVisible} size="small" variant="invisible"
                  className="sidebar-toggle" icon={SidebarExpandIcon} aria-label="Show sidebar"
                  aria-expanded={filesVisible} aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />} />
              <Reader ref={readerRef} key={document.path} document={document} mediaDimensions={mediaDimensions} request={readerRequest} bookmarkState={bookmarkState}
                navigate={navigate} onReload={reloadDocument} onActivity={readerActivity} />
            </>}
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles>;
}

createRoot(document.getElementById('root')).render(<ThemeProvider colorMode="auto" contextOnly><BrowserSession><App /></BrowserSession></ThemeProvider>);
