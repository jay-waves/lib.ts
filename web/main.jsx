import { IconButton } from '@primer/react';
import { BrowserSession, SessionActivity } from './session-activity';
import { HISTORY_GROUPS } from './history/time-labels.mjs';
import { visibleEvents } from './visible-events.mjs';
import { parseDocumentOpenEvent } from './session-events.mjs';
import { sortFileTree, fileTreeForView, fileListFromPaths } from './file-tree.mjs';
import { useFileTree } from './use-file-tree';
import { apiBase, pageBase, repoId, routeKind, fileUrl } from './urls.mjs';
import { searchUrl, gitUrl, parseRepositoryLocation } from './paths.ts';
import React, { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BaseStyles, Button, Spinner } from '@primer/react';
import { Dialog as SideSheet } from '@primer/react/experimental';
import { FocusCenterIcon, SortDescIcon, FoldIcon, FileDirectoryIcon, SearchIcon, SidebarExpandIcon, ListUnorderedIcon, RepoIcon, GitBranchIcon, BookmarkIcon, HistoryIcon } from '@primer/octicons-react';
import { useBookmarks } from './bookmarks/bookmarks';
import { RecentFiles, useRecentFiles } from './history/recent-files';
import { RepoPicker } from './repo-picker';
import { PathBar } from './path-bar';
import { useWorkspaceSearch } from './search/workspace-search.tsx';
import { useGitStatus } from './git/use-git-status.tsx';
import { readSidebarState, saveSidebarState } from './sidebar-state.mjs';
import { readRepositoryDisplayState, saveRepositoryDisplayState } from './directory-state.mjs';
import { flushReadingPositions } from './reading-state.mjs';
import { readerRouteRequest } from './reader-session.mjs';
import { randomId } from './random-id.mjs';
import { FileTree } from './file-tree-view.tsx';
import { BookmarkList } from './bookmarks/bookmark-list';
import { SymbolsPanel } from './symbols/symbols-panel.tsx';
import { DirectoryView } from './directory-view.tsx';
import { FilePage } from './file-page.jsx';
import { adjacentMediaPath, mediaNavigationDirection } from './media/media-navigation.mjs';
import './markdown/theme.css';
import './markdown/heading-sections.css';
import './markdown/highlight.css';
import './markdown/footnotes.css';
import 'katex/dist/katex.min.css';
import './primer.css';
import './theme.css';
import './git/theme.css';
import './media/image-theme.css';
import { ThemeProvider } from '@primer/react/next';
import './style.css';
import './ui.css';
import './sidebar.css';
import './tailwind.css';

const GitPanel = lazy(() => import('./git/git-panel.tsx'));
const GitDiffView = lazy(() => import('./git/git-diff-view'));

const emptySymbols = [];

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
  const { tree, index: treeIndex, loading: treeLoading, error: treeError, loadDirectory } = useFileTree(apiBase, selected, active, display.showHidden === true);
  const bookmarkState = useBookmarks(active && Boolean(apiBase));
  const [recentOnly, setRecentOnly] = useState(() => Boolean(initialSidebar.recentOnly));
  const [documentRevision, setDocumentRevision] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState(() => expandedPathEntries(currentPath()));
  const readerRef = useRef(null);
  const selectedNode = treeIndex.get(selected);
  const [pageState, setPageState] = useState(null);
  const currentPage = pageState?.path === selected ? pageState : null;
  const progress = currentPage?.progress ?? {};
  const activeView = currentPage?.view ?? 'preview';
  const symbols = currentPage?.symbols ?? emptySymbols;
  const recentState = useRecentFiles(active && Boolean(apiBase), currentPage?.loaded ? selected : null);
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
  const mainPanelRef = useRef(null);

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
      readerRef.current?.capture?.();
      if (request.repo !== repo && repo) { flushReadingPositions(); location.assign(request.url); return; }
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
      readerRef.current?.capture?.();
      const path = currentPath();
      setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
      setSidebarTab(tab => kind === 'search' || kind === 'git' ? kind : ['search', 'git'].includes(tab) ? 'files' : tab);
      setReaderRequest(readerRouteRequest(path, location.search));
      setSelected(path);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const name = selected.split('/').filter(Boolean).at(-1) || tree?.name || 'Notes';
    if (active) window.document.title = name;
  }, [selected, tree?.name, active]);
  function navigate(path, directory = false, line = null, page = null) {
    const playbackTime = typeof line === 'object' && line !== null ? line.playbackTime : undefined;
    if (typeof line === 'object') line = null;
    readerRef.current?.capture?.();
    setGitPath(null);
    setSidebarTab(tab => tab === 'search' ? 'files' : tab);
    setReaderRequest({ path, line, page, view: line ? 'raw' : null, playbackTime });
    history.pushState(null, '', fileUrl(path, directory) + (page ? `?page=${page.index + 1}&x=${page.x}&y=${page.y}` : line ? `?line=${line}#L${line}` : ''));
    setExpandedPaths(paths => ({ ...paths, ...expandedPathEntries(path) }));
    setSelected(path);
    if (narrow) setFilesVisible(false);
    if (directory) setSidebarTab('files');
  }
  const parts = (gitPath ?? selected).split('/').filter(Boolean);
  const filteredTree = useMemo(() => {
    if (bookmarksOnly) return fileListFromPaths(bookmarkState.bookmarks.map(item => item.path));
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
    readerRef.current?.capture?.();
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
              readerRef.current?.capture?.();
              history.pushState(null, '', gitUrl(repoId, path, scope));
              setGitPath(path);
              setGitScope(scope);
              mainPanelRef.current?.scrollTo({ top: 0 });
              if (narrow) setFilesVisible(false);
            }} />
          </Suspense>}
          {active && <RepoPicker hidden={sidebarTab !== 'repos'} />}
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
              expandedPaths={expandedPaths} setExpandedPaths={setExpandedPaths} loadDirectory={loadDirectory} />
            : <div className="sidebar-empty">{bookmarksOnly ? bookmarkState.bookmarks.length ? 'No bookmarked files available' : 'Open a file to add a bookmark.' : 'No matching files'}</div> : treeLoading ? <div className="sidebar-loading"><Spinner size="small" /></div> : null}</div>
          </> : null}
    <SymbolsPanel symbols={symbols} status={progress} onSelect={jumpToSymbol}
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
        <main className={`main-panel col-start-4 row-start-1 h-dvh max-h-dvh min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-y-none bg-surface${gitPath === null && !searchMode && currentPage?.viewport ? ' document-viewport' : ''}`} ref={mainPanelRef} tabIndex={0}
          onKeyDownCapture={event => {
            if (searchMode || gitPath !== null || !currentPage?.media) return;
            const direction = mediaNavigationDirection(event);
            if (!direction) return;
            event.preventDefault();
            event.stopPropagation();
            const parent = selected.split('/').slice(0, -1).join('/');
            const siblings = parent ? treeIndex.get(parent)?.children : tree?.children;
            const path = adjacentMediaPath(sortMode === 'name' ? siblings : sortFileTree(siblings), selected, direction);
            if (path) navigate(path);
          }}
          onKeyDown={event => {
            if (!searchMode && gitPath === null) readerRef.current?.handleKeyDown?.(event);
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
                {narrow && (gitPath !== null || searchMode || !currentPage?.file) && <IconButton unsafeDisableTooltip ref={sidebarToggleRef} hidden={filesVisible}
                  size="small" variant="invisible" className="sidebar-toggle" icon={SidebarExpandIcon}
                  aria-label="Show sidebar" aria-expanded={filesVisible}
                  aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />}
              </div>
            </div>
          </div>}
          {searchMode && codeSearch.results}
          {!searchMode && gitPath !== null && <Suspense fallback={<div className="status"><Spinner /> Loading diff…</div>}>
            <GitDiffView key={`${gitScope}:${gitPath}`} path={gitPath} scope={gitScope} active={active} revision={gitState.updatedAt}
              onOpen={() => navigate(gitPath)}
              onClose={() => { history.pushState(null, '', fileUrl(selected)); setGitPath(null); }} />
          </Suspense>}
          <div className="content-panel ui-panel" hidden={searchMode || gitPath !== null}>
            {!repoId && <div className="status empty-repository" role="status">
              <p>No repository is open.</p>
              <Button size="small" onClick={() => { setSidebarTab('repos'); setFilesVisible(true); }}>Add a repository</Button>
            </div>}
            {Boolean(repoId) && <>
            {bookmarkState.error && !bookmarksOnly && <div className="action-error" role="alert">{bookmarkState.error}</div>}
            {selected ? <FilePage key={`${apiBase}:${selected}`} ref={readerRef} path={selected} request={readerRequest}
              externalRevision={documentRevision} visible={!searchMode && gitPath === null}
              loadDirectory={loadDirectory} directory={selectedNode?.type === 'directory' ? selectedNode : null} treeError={treeError}
              navigate={navigate} display={display} onDisplayChange={changeDisplay} bookmarkState={bookmarkState} onState={setPageState}
              sidebarToggle={narrow && <IconButton unsafeDisableTooltip ref={sidebarToggleRef} hidden={filesVisible} size="small" variant="invisible"
                className="sidebar-toggle" icon={SidebarExpandIcon} aria-label="Show sidebar"
                aria-expanded={filesVisible} aria-controls="sidebar-content" onClick={() => setFilesVisible(true)} />} />
              : tree && <DirectoryView key="root" treeError={treeError} loadDirectory={loadDirectory} directory={tree} navigate={navigate} display={display} onDisplayChange={changeDisplay} />}
            </>}
          </div>
        </main>
      </div>
    </div>
  </BaseStyles>;
}

createRoot(document.getElementById('root')).render(<ThemeProvider colorMode="auto" contextOnly><BrowserSession><App /></BrowserSession></ThemeProvider>);
