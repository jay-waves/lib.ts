import { apiBase, fileUrl as documentUrl } from '../urls.mjs';
import React, { Suspense, use, useCallback, useEffect, useId, useMemo, useRef, useState, useReducer } from 'react';
import { ActionList, Button, CounterLabel, Link, Spinner } from '@primer/react';
import { BookmarkIcon, CodeIcon, FileCodeIcon, FileDirectoryIcon, UnfoldIcon, FoldIcon } from '@primer/octicons-react';
import { SearchInput } from './search-input';
import { loadRawHighlighter } from '../raw/raw-highlight-loader.mjs';
import { parseSearchQuery, updateQueryQualifier, normalizeLanguage, cardMatchLines } from './search-query.ts';
import './code-search.css';
import { FileTree } from '../file-tree-view';
import { fileTreeFromPaths } from '../file-tree.mjs';
import type { SearchResponse } from '../api/contracts';
import { initialSearchState, searchReducer } from './search-state';
import { filterSearchPaths } from './path-search';
import { searchRepository } from '../api/search';
import { ApiError } from '../api/client';

type SearchFile = SearchResponse['files'][number];
type SearchLine = SearchFile['snippets'][number]['lines'][number];
type Navigate = (path: string, directory?: boolean, line?: number) => void;
type HighlightRaw = (source: string, path: string) => string;
type FacetItem = { value: string; count?: number };
export interface SearchConfig { query: string; scope?: '' | 'current-file' | 'files' | 'bookmarks' | 'symbols' }
import { SymbolLevelIcon, type DocumentSymbol } from '../symbols/symbols-panel';
export type SearchSymbol = DocumentSymbol;
export interface CodeSearchOptions {
  config: SearchConfig;
  onConfig: (config: SearchConfig) => void;
  navigate: Navigate;
  active: boolean;
  currentFile: string;
  scrollRef: React.RefObject<HTMLElement | null>;
  scopeFilter?: React.ReactNode;
  paths?: readonly string[];
  pathSuggestions?: readonly FacetItem[];
  symbols?: readonly SearchSymbol[];
  onSelectSymbol?: (symbol: SearchSymbol) => void;
}
interface SnippetProps { lines: SearchLine[]; path: string; navigate: Navigate; highlightRaw?: HighlightRaw }
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

const defaultLanguages = ['Markdown', 'Typst', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Lua'].map(value => ({ value }));
const languageColors: Record<string, string> = {
  markdown: '#083fa1', typst: '#239dad', javascript: '#f1e05a', typescript: '#3178c6',
  python: '#3572a5', go: '#00add8', rust: '#dea584', lua: '#000080',
  c: '#555555', 'c++': '#f34b7d', java: '#b07219', shell: '#89e051',
  powershell: '#012456', json: '#292929', css: '#563d7c', html: '#e34c26',
  yaml: '#cb171e', toml: '#9c4221', ruby: '#701516', php: '#4f5d95', sql: '#e38c00',
};

function LanguageSwatch({ language }: { language: string }) {
  return <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
    <span className="size-2.5 rounded-full shadow-[inset_0_0_0_1px_rgb(128_128_128/25%)]"
      style={{ backgroundColor: languageColors[normalizeLanguage(language)] || '#858585' }} />
  </span>;
}

const searchTips = [
  <>Enter a query in the sidebar and press <kbd>Enter</kbd> to search.</>,
  <>Use <code>/TODO|FIXME/i</code> to find either term, ignoring case.</>,
  <>Add <code>case:yes</code> to match uppercase and lowercase exactly.</>,
  <>Search respects .gitignore by default. Add <code>gitignore:no</code> to include ignored files.</>,
  <>Add <code>lang:js</code> to search only JavaScript files.</>,
  <>Add <code>path:src/</code> to search within the src directory.</>,
  <>Use <code>path:src/**/*.js</code> to match JavaScript files throughout src.</>,
];

function SearchTips({ active }: { active: boolean }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * searchTips.length));
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setIndex(Math.floor(Math.random() * searchTips.length));
    wasActive.current = active;
  }, [active]);
  return <div className="ui-empty min-h-[clamp(200px,45dvh,420px)] box-border justify-center px-5 py-8" aria-label="Search tips">
    <p className="m-0 min-h-[3em] max-w-[560px] leading-relaxed wrap-anywhere">{searchTips[index]}</p>
  </div>;
}

function fileUrl(path: string, line: number) {
  return `${documentUrl(path)}?line=${line}#L${line}`;
}

// Insert marks into text nodes, retaining syntax spans and never treating source as HTML.
function highlightedLine(line: SearchLine, path: string, highlightRaw?: HighlightRaw) {
  const container = window.document.createElement('div');
  if (highlightRaw) container.innerHTML = highlightRaw(line.text, path);
  else container.textContent = line.text;
  const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of nodes) {
    const text = node.textContent;
    const ranges = line.ranges.filter(([start, end]) => start < offset + text.length && end > offset);
    const fragment = window.document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of ranges) {
      const from = Math.max(0, start - offset), to = Math.min(text.length, end - offset);
      fragment.append(window.document.createTextNode(text.slice(cursor, from)));
      const mark = window.document.createElement('mark');
      mark.textContent = text.slice(from, to);
      fragment.append(mark);
      cursor = to;
    }
    fragment.append(window.document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
    offset += text.length;
  }
  return container.innerHTML;
}

function SnippetLines({ lines: sourceLines, path, navigate, highlightRaw }: SnippetProps) {
  const lines = useMemo(() => sourceLines.map(line => ({ ...line, html: highlightedLine(line, path, highlightRaw) })), [sourceLines, path, highlightRaw]);
  if (!lines.length) return null;
  return <div className="search-snippet" aria-label={`Lines ${lines[0].number}–${lines.at(-1)?.number}`}>
    {lines.map((line, index) => <React.Fragment key={line.number}>
      {index > 0 && line.number > lines[index - 1].number + 1 && <div className="search-code-gap" aria-hidden="true" />}
      <div className="search-code-line">
      <a className="search-line-number" href={fileUrl(path, line.number)} aria-label={`Open ${path} at line ${line.number}`}
        onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); navigate(path, false, line.number); }}>{line.number}</a>
      <code className="hljs" dangerouslySetInnerHTML={{ __html: line.html }} />
      {line.clipped && <span className="search-line-clipped">…</span>}
      </div>
    </React.Fragment>)}
  </div>;
}

function HighlightedSnippet(props: SnippetProps) {
  const { highlightRaw } = use<{ highlightRaw: HighlightRaw }>(loadRawHighlighter());
  return <SnippetLines {...props} highlightRaw={highlightRaw} />;
}

function Snippet(props: SnippetProps) {
  return <Suspense fallback={<SnippetLines {...props} />}><HighlightedSnippet {...props} /></Suspense>;
}

function SearchResultsLayout({ label, summary, busy, children }: {
  label: string;
  summary?: React.ReactNode;
  busy?: boolean;
  children: React.ReactNode;
}) {
  return <section className="code-search-results mx-auto mb-9 pt-sidebar-top w-[var(--content-width)] box-border min-w-0" aria-label={label} aria-busy={busy}>
    {summary && <div className="search-results-title mb-1 flex min-h-row box-border items-center gap-2 px-3 text-[13px] leading-5 [&>span]:text-muted" role="status" aria-live="polite">{summary}</div>}
    {children}
  </section>;
}

function ResultCard({ file, navigate, selected = false, onFocus }: { file: SearchFile; navigate: Navigate; selected?: boolean; onFocus: React.FocusEventHandler<HTMLElement> }) {
  const snippetId = useId();
  const [expanded, setExpanded] = useState(false);
  const firstLine = file.snippets.flatMap(snippet => snippet.lines).find(line => line.ranges.length)?.number || 1;
  const allLines = useMemo(() => cardMatchLines(file, true), [file]);
  const lines = useMemo(() => cardMatchLines(file, expanded), [file, expanded]);
  return <article className={`min-w-0 overflow-hidden rounded-lg border border-solid border-border bg-surface${selected ? ' outline-2 outline-solid outline-accent outline-offset-2' : ''}`} aria-label={file.path}
    tabIndex={selected ? 0 : -1} data-search-result onFocus={onFocus}>
    <header className="flex min-h-row box-border items-center gap-2 border-0 border-b border-solid border-divider bg-surface px-3 py-1 text-ui [&>svg]:shrink-0 [&>svg]:text-muted [&>a]:flex [&>a]:min-w-0 [&>a]:flex-wrap [&>a]:items-baseline [&>a]:gap-x-2 [&>a]:font-semibold [&>a]:wrap-anywhere max-[960px]:flex-wrap max-[960px]:[&>a]:flex-1">
      <FileCodeIcon />
      <Link href={fileUrl(file.path, firstLine)} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(file.path, false, firstLine);
      }}><span className="text-accent">{file.path.replace(/\\/g, '/').replace(/\/+/g, '/')}</span></Link>
      <span className="ms-auto whitespace-nowrap text-meta text-muted max-[960px]:ms-[26px] max-[960px]:w-full">{file.language} · {file.matchCount.toLocaleString()} {file.matchCount === 1 ? 'match' : 'matches'}</span>
    </header>
    <div id={snippetId} className="overflow-clip bg-subtle">
      <Snippet lines={lines} path={file.path} navigate={navigate} />
    </div>
    <footer className="bg-subtle text-meta empty:hidden">
      {file.snippetsTruncated && <p className="m-0 px-3 py-1 text-muted">Preview limited. Open the file to see all matches.</p>}
      {allLines.length > 5 &&
        <button type="button" className="ui-disclosure gap-0 border-t border-solid border-divider ps-0 pe-4 text-meta hover:bg-selected focus-visible:bg-selected" aria-expanded={expanded} aria-controls={snippetId}
          onClick={() => setExpanded(value => !value)}>
          <span className="flex w-14 flex-none items-center justify-end pe-3.5" aria-hidden="true">{expanded ? <FoldIcon size={16} /> : <UnfoldIcon size={16} />}</span>
          <span>{expanded ? 'Show less' : `Show ${allLines.length - 5} more ${allLines.length - 5 === 1 ? 'line' : 'lines'}`}</span>
        </button>}

    </footer>
  </article>;
}

function Facet({ title, items, selected, onSelect, icon, languages = false }: { title: string; items: readonly FacetItem[]; selected: string; onSelect: (value: string) => void; icon: typeof CodeIcon; languages?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const limit = languages ? 5 : 12;
  const options = selected && !items.some(item => item.value === selected) ? [...items, { value: selected }] : items;
  const visible = expanded ? [...options] : options.slice(0, limit);
  const selectedItem = options.find(item => item.value === selected);
  if (selectedItem && !visible.includes(selectedItem)) visible.push(selectedItem);
  return <section className="search-facet">
    <h2 className="search-facet-title">{title}</h2>
    <ActionList variant="full" role="listbox" aria-label={title}>
      <ActionList.Item className="sidebar-list-item group" active={!selected} aria-selected={!selected} onSelect={() => onSelect('')} role="option">
        <ActionList.LeadingVisual>{React.createElement(icon)}</ActionList.LeadingVisual>
        <span className="text-meta leading-5">All {title.toLowerCase()}</span>
      </ActionList.Item>
      {visible.map(item => <ActionList.Item className="sidebar-list-item group" key={item.value} active={selected === item.value} aria-selected={selected === item.value} role="option"
        onSelect={() => onSelect(selected === item.value ? '' : item.value)}>
        <ActionList.LeadingVisual>{languages ? <LanguageSwatch language={item.value} /> : React.createElement(icon)}</ActionList.LeadingVisual>
        <span className="search-facet-label">{item.value}</span>
        {item.count != null && <ActionList.TrailingVisual><CounterLabel>{item.count}</CounterLabel></ActionList.TrailingVisual>}
      </ActionList.Item>)}
    </ActionList>
    {options.length > limit && <Button size="small" variant="invisible" onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Show fewer' : `Show all ${options.length}`}
    </Button>}
  </section>;
}

export function useCodeSearch({ config, onConfig, navigate, active, currentFile, scrollRef, scopeFilter, paths = [], pathSuggestions = [], symbols = [], onSelectSymbol }: CodeSearchOptions) {
  const { query, scope = '' } = config;
  const syntax = useMemo(() => {
    try { return { parsed: parseSearchQuery(query), error: '' }; }
    catch (error) { return { parsed: parseSearchQuery(''), error: errorMessage(error) }; }
  }, [query]);
  const language = syntax.parsed.languages.at(-1) || '';
  const path = syntax.parsed.paths.at(-1)?.value || '';
  const textQuery = syntax.parsed.text;
  const fileSearch = scope === 'files';
  const searchingFiles = fileSearch && Boolean(query.trim());
  const pathSearch = fileSearch || scope === 'bookmarks';
  const symbolSearch = scope === 'symbols';
  const repositoryScope = fileSearch ? 'paths' : scope === 'bookmarks' || scope === 'symbols' ? '' : scope;
  const [expandedResultPaths, setExpandedResultPaths] = useState<Record<string, boolean>>({});
  useEffect(() => setExpandedResultPaths({}), [query, scope]);
  const symbolResults = symbolSearch && !syntax.error ? symbols.filter(symbol => {
    if (!textQuery) return true;
    if (syntax.parsed.regex) {
      try { return new RegExp(textQuery, syntax.parsed.caseSensitive ? 'u' : 'iu').test(symbol.name); }
      catch { return false; }
    }
    return syntax.parsed.caseSensitive ? symbol.name.includes(textQuery)
      : symbol.name.toLocaleLowerCase().includes(textQuery.toLocaleLowerCase());
  }) : [];
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const [revision, setRevision] = useState(0);
  const [state, dispatch] = useReducer(searchReducer, initialSearchState);
  const result = state.status === 'ready' ? state.result : null;
  const pathResults = useMemo(() => searchingFiles ? result?.files || []
    : pathSearch && !syntax.error ? filterSearchPaths(paths, query) : [], [searchingFiles, result, pathSearch, syntax.error, paths, query]);
  const resultTree = useMemo(() => fileTreeFromPaths(pathResults.map(file => file.path)), [pathResults]);

  const loading = state.status === 'loading';
  const loadingMore = state.status === 'ready' && state.page.status === 'loading';
  const pageError = state.status === 'ready' && state.page.status === 'error' ? state.page.error : undefined;
  const pageExpired = state.status === 'ready' && state.page.status === 'error' && state.page.expired;
  const searchError = state.status === 'error' ? state.error : '';
  const [activeResult, setActiveResult] = useState(-1);
  const error = syntax.error || searchError;
  const sentinelRef = useRef<HTMLDivElement>(null);
  const resultListRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0), moreRequest = useRef<AbortController | null>(null);
  const snapshot = useRef<{ identity: string; searchId: string } | null>(null);

  useEffect(() => { setActiveResult(-1); }, [result?.searchId]);

  function navigateResults(event: React.KeyboardEvent<HTMLDivElement>) {
    const list = resultListRef.current;
    const cards = list?.querySelectorAll<HTMLElement>('[data-search-result]');
    if (!cards?.length) return;
    // Keep arrow keys inside links and buttons available for their own controls.
    if (event.target !== list && event.target instanceof Element && event.target.matches('a, button, input, [contenteditable="true"]')) return;
    let next = activeResult;
    if (event.key === 'ArrowDown') next = activeResult < 0 ? 0 : Math.min(activeResult + 1, cards.length - 1);
    else if (event.key === 'ArrowUp') next = activeResult < 0 ? cards.length - 1 : Math.max(activeResult - 1, 0);
    else if (event.key === 'Enter' && activeResult >= 0) {
      event.preventDefault();
      const file = result?.files[activeResult];
      if (file) navigate(file.path, false, file.snippets.flatMap(snippet => snippet.lines).find(line => line.ranges.length)?.number || 1);
      return;
    } else return;
    event.preventDefault();
    setActiveResult(next);
    cards[next]?.focus();
  }

  useEffect(() => {
    if (!active) return;
    const id = ++generation.current;
    const controller = new AbortController();
    moreRequest.current?.abort();
    moreRequest.current = null;
    scrollRef.current?.scrollTo({ top: 0 });
    if (scope === 'bookmarks' || symbolSearch || (fileSearch ? !searchingFiles : !textQuery.trim()) || syntax.error) {
      dispatch({ type: 'search-idle' });
      return () => controller.abort();
    }
    dispatch({ type: 'search-start' });
    const identity = JSON.stringify([query, currentFile, revision, scope]);
    const cached = snapshot.current?.identity === identity ? snapshot.current : null;
    searchRepository(apiBase, {
      query, currentFile, scope: repositoryScope,
      ...(cached ? { searchId: cached.searchId } : { refresh: true }),
    }, controller.signal).then(value => {
      if (generation.current !== id || controller.signal.aborted) return;
      snapshot.current = { identity, searchId: value.searchId };
      dispatch({ type: 'search-success', result: value });
    }).catch(cause => {
      if (controller.signal.aborted || generation.current !== id) return;
      if (cached && cause instanceof ApiError && cause.status === 410) {
        snapshot.current = null;
        setRevision(value => value + 1);
      } else dispatch({ type: 'search-error', error: errorMessage(cause) });
    });
    return () => { controller.abort(); moreRequest.current?.abort(); };
  }, [active, query, textQuery, currentFile, revision, scope, syntax.error, scrollRef, symbolSearch, repositoryScope, fileSearch, searchingFiles]);

  const loadMore = useCallback(async () => {
    if (scope === 'bookmarks' || symbolSearch || !result || result.nextOffset === null || moreRequest.current) return;
    if (snapshot.current?.identity !== JSON.stringify([query, currentFile, revision, scope])
      || snapshot.current.searchId !== result.searchId) return;
    const id = generation.current;
    const controller = new AbortController();
    moreRequest.current = controller;
    dispatch({ type: 'page-start', searchId: result.searchId });
    try {
      const page = await searchRepository(apiBase, {
        query, currentFile, scope: repositoryScope,
        searchId: result.searchId, offset: result.nextOffset,
      }, controller.signal);
      if (generation.current !== id || controller.signal.aborted) return;
      dispatch({ type: 'page-success', searchId: result.searchId, result: page });
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === id) dispatch({ type: 'page-error', searchId: result.searchId, error: errorMessage(cause), expired: cause instanceof ApiError && cause.status === 410 });
    } finally {
      if (moreRequest.current === controller) moreRequest.current = null;
    }
  }, [result, query, currentFile, revision, repositoryScope, symbolSearch, scope]);

  useEffect(() => {
    if (scope === 'bookmarks' || symbolSearch || !active || !result || result.nextOffset === null || pageError || loadingMore) return;
    // File searches show all matches automatically; browsing an empty query
    // uses the existing tree index and mounts only expanded branches.
    if (fileSearch) {
      if (searchingFiles) void loadMore();
      return;
    }
    if (!sentinelRef.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scrollRef.current, rootMargin: '350px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [active, result, loadMore, loadingMore, pageError, scrollRef, symbolSearch, scope, fileSearch, searchingFiles]);

  function restartSearch() {
    snapshot.current = null;
    setRevision(value => value + 1);
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    onConfig({ ...config, query: value });
    snapshot.current = null;
    setRevision(current => current + 1);
  }
  function clearSearch() {
    setDraft('');
    onConfig({ ...config, query: '' });
    snapshot.current = null;
  }
  function filter(kind: 'lang' | 'path', value: string) {
    try {
      const updated = updateQueryQualifier(query, kind, value);
      setDraft(updated);
      onConfig({ ...config, query: updated });
    } catch (cause) { dispatch({ type: 'search-error', error: errorMessage(cause) }); }
  }
  function clearFilters() {
    try {
      const updated = updateQueryQualifier(updateQueryQualifier(query, 'lang', ''), 'path', '');
      setDraft(updated); onConfig({ ...config, query: updated });
    } catch (cause) { dispatch({ type: 'search-error', error: errorMessage(cause) }); }
  }
  const sidebar = <>
    <form className="sidebar-search block" onSubmit={submit}>
      <SearchInput size="small" block autoFocus aria-label={pathSearch ? 'Filter file names and paths' : 'Search text and code'}
        placeholder={pathSearch ? 'Filter files…' : scope === 'current-file' ? 'Search current file…' : 'Search code…'}
        clearable={Boolean(draft || query)} onClear={clearSearch}
        value={draft} maxLength={256} onChange={event => setDraft(event.target.value)} />
      {(language || path) && <div className="mt-2.5 flex items-center justify-end gap-1 [&_button]:text-meta! [&_button]:text-muted! [&_button:hover]:text-accent!">
        <Button variant="invisible" size="small" onClick={clearFilters}>Clear filters</Button>
      </div>}
    </form>
    <div className="sidebar-scroll" aria-label="Search filters">
      {scopeFilter}
      <Facet title="Languages" items={result ? result.facets.languages : defaultLanguages}
        selected={result?.facets.languages.find(item => normalizeLanguage(item.value) === normalizeLanguage(language))?.value || language}
        icon={CodeIcon} languages onSelect={value => filter('lang', value)} />
      <Facet title="Paths" items={result ? result.facets.paths : pathSuggestions} selected={path} icon={FileDirectoryIcon}
        onSelect={value => filter('path', value)} />
    </div>
  </>;
  const pagination = result?.nextOffset != null && <div className="flex min-h-[100px] flex-col items-center justify-center gap-2" ref={sentinelRef}>
    {pageError && <p role="alert">{pageError}</p>}
    {loadingMore ? <Spinner size="small" /> : (!fileSearch || pageError) && <Button onClick={pageExpired ? restartSearch : loadMore}>{pageExpired ? 'Search again' : pageError ? 'Retry loading' : 'Load more results'}</Button>}
  </div>;
  const results = <SearchResultsLayout label="Search results" busy={loading}
    summary={loading ? <><Spinner size="small" /> Searching…</> : result ?
      <><strong>{result.total.toLocaleString()}{result.truncated ? '+' : ''} files</strong><span>· {result.matchCount.toLocaleString()}{result.truncated ? '+' : ''} matches</span></> : null}>
    {error && <div className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui [&_h2]:text-danger!" role="alert"><h2>Could not search</h2><p>{error}</p></div>}
    {result?.truncated && <p className="mx-auto mb-4 max-w-[1100px] rounded-md border border-solid border-[var(--color-border-attention-muted)] bg-[var(--color-bg-attention-muted)] p-3 text-ui" role="status">Results are limited. Counts cover the files found so far. Use a more specific query to find more.</p>}
    {!symbolSearch && !textQuery.trim() && !syntax.error && <SearchTips active={active} />}
    {result?.total === 0 && <div className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui"><p>No matching code. Try another term or clear the filters.</p></div>}
    <div className="flex flex-col gap-3" ref={resultListRef} role="group" tabIndex={0} aria-label="Search results. Use the up and down arrow keys to select a file."
      onKeyDown={navigateResults}>
      {result?.files.map((file, index) => <ResultCard key={`${result.searchId}:${file.path}`} file={file} navigate={navigate}
        selected={activeResult === index} onFocus={() => setActiveResult(index)} />)}
    </div>
    {pagination}
  </SearchResultsLayout>;
  const filteredResults = <SearchResultsLayout label="Filtered files" busy={searchingFiles && loading} summary={searchingFiles && loading ? <><Spinner size="small" /> Searching…</> : <strong>{searchingFiles ? result?.total ?? 0 : pathResults.length}{searchingFiles && result?.truncated ? '+' : ''} files</strong>}>
    {(searchingFiles ? error : syntax.error) && <p className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui [&_h2]:text-danger!" role="alert">{searchingFiles ? error : syntax.error}</p>}
    {!(searchingFiles ? error || loading : syntax.error) && !pathResults.length && <p className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui">No matching files.</p>}
    {scope === 'files' ? <FileTree nodes={resultTree} label="Matching files" selected={currentFile}
      navigate={navigate} searching={Boolean(query.trim())} variant="results" navigateDirectories={false}
      expandedPaths={expandedResultPaths} setExpandedPaths={setExpandedResultPaths} />
      : <ActionList variant="full">{pathResults.map(file => <ActionList.Item className="search-result-item" key={file.path} onSelect={() => navigate(file.path)}>
      <ActionList.LeadingVisual>{scope === 'bookmarks' ? <BookmarkIcon /> : <FileCodeIcon />}</ActionList.LeadingVisual>
      {file.path}
    </ActionList.Item>)}</ActionList>}
    {searchingFiles && result?.truncated && <p className="px-3 text-ui text-muted">Results are limited. Refine the search to find more files.</p>}
    {searchingFiles && pagination}
  </SearchResultsLayout>;
  const filteredSymbols = <SearchResultsLayout label="Filtered symbols" summary={<strong>{symbolResults.length} symbols</strong>}>
    {syntax.error && <p className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui [&_h2]:text-danger!" role="alert">{syntax.error}</p>}
    {!syntax.error && !symbolResults.length && <p className="px-5 py-16 text-center text-muted [&_h2]:my-[18px] [&_h2]:text-xl [&_h2]:text-fg [&_p]:text-ui">{symbols.length ? 'No matching symbols.' : 'No symbols in the current document.'}</p>}
    <ActionList variant="full">{symbolResults.map(symbol => <ActionList.Item className="search-result-item" key={symbol.id} onSelect={() => onSelectSymbol?.(symbol)}>
      <ActionList.LeadingVisual><SymbolLevelIcon level={symbol.level} kind={symbol.kind} /></ActionList.LeadingVisual>
      <span>{symbol.name}</span>
      <ActionList.Description>{symbol.page ? `Page ${symbol.page}` : `Line ${symbol.line}`}</ActionList.Description>
    </ActionList.Item>)}</ActionList>
  </SearchResultsLayout>;
  return { sidebar, results: pathSearch ? filteredResults : symbolSearch ? filteredSymbols : results };
}
