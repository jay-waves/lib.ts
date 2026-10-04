import { apiBase, fileUrl as documentUrl } from './urls.mjs';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ActionList, Button, CounterLabel, Link, Spinner } from '@primer/react';
import { BookmarkIcon, CodeIcon, FileCodeIcon, FileDirectoryIcon, ListUnorderedIcon, UnfoldIcon, FoldIcon } from '@primer/octicons-react';
import { SearchInput } from './search-input.jsx';
import { highlightRaw } from './raw-highlight.mjs';
import { parseSearchQuery, updateQueryQualifier, normalizeLanguage, cardMatchLines } from './search-query.mjs';
import './code-search.css';
import { filterSearchPaths } from './path-search.mjs';

const defaultLanguages = ['Markdown', 'Typst', 'JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Lua'].map(value => ({ value }));
const languageColors = {
  markdown: '#083fa1', typst: '#239dad', javascript: '#f1e05a', typescript: '#3178c6',
  python: '#3572a5', go: '#00add8', rust: '#dea584', lua: '#000080',
  c: '#555555', 'c++': '#f34b7d', java: '#b07219', shell: '#89e051',
  powershell: '#012456', json: '#292929', css: '#563d7c', html: '#e34c26',
  yaml: '#cb171e', toml: '#9c4221', ruby: '#701516', php: '#4f5d95', sql: '#e38c00',
};

function LanguageSwatch({ language }) {
  return <span className="search-language-swatch" aria-hidden="true"
    style={{ backgroundColor: languageColors[normalizeLanguage(language)] || '#858585' }} />;
}

const searchTips = [
  <>Enter a query in the sidebar and press <kbd>Enter</kbd> to search.</>,
  <>Use <code>/TODO|FIXME/i</code> to find either term, ignoring case.</>,
  <>Add <code>case:yes</code> to match uppercase and lowercase exactly.</>,
  <>Add <code>lang:js</code> to search only JavaScript files.</>,
  <>Add <code>path:src/</code> to search within the src directory.</>,
  <>Use <code>path:src/**/*.js</code> to match JavaScript files throughout src.</>,
];

function SearchTips({ active }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * searchTips.length));
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setIndex(Math.floor(Math.random() * searchTips.length));
    wasActive.current = active;
  }, [active]);
  return <div className="search-message search-tips" aria-label="Search tips">
    <p className="search-tip-label">Search tip</p>
    <p className="search-tip-text">{searchTips[index]}</p>
  </div>;
}

function fileUrl(path, line) {
  return `${documentUrl(path)}?line=${line}#L${line}`;
}

// Insert marks into text nodes, retaining syntax spans and never treating source as HTML.
function highlightedLine(line, path) {
  const container = window.document.createElement('div');
  container.innerHTML = highlightRaw(line.text, path);
  const walker = window.document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
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

function Snippet({ lines: sourceLines, path, navigate }) {
  const lines = useMemo(() => sourceLines.map(line => ({ ...line, html: highlightedLine(line, path) })), [sourceLines, path]);
  return <div className="search-snippet" aria-label={`Lines ${lines[0].number}–${lines.at(-1).number}`}>
    {lines.map((line, index) => <div key={line.number} className={`search-code-line ${index > 0 && line.number > lines[index - 1].number + 1 ? 'after-gap' : ''}`}>
      <a className="search-line-number" href={fileUrl(path, line.number)} aria-label={`Open ${path} at line ${line.number}`}
        onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault(); navigate(path, false, line.number); }}>{line.number}</a>
      <code className="hljs" title={line.text} dangerouslySetInnerHTML={{ __html: line.html }} />
      {line.clipped && <span className="search-line-clipped" title="Long line excerpt">…</span>}
    </div>)}
  </div>;
}

function ResultCard({ file, navigate, selected = false, onFocus }) {
  const snippetId = useId();
  const [expanded, setExpanded] = useState(false);
  const firstLine = file.snippets.flatMap(snippet => snippet.lines).find(line => line.ranges.length)?.number || 1;
  const allLines = useMemo(() => cardMatchLines(file, true), [file]);
  const lines = useMemo(() => cardMatchLines(file, expanded), [file, expanded]);
  return <article className={`search-result-card${selected ? ' is-keyboard-active' : ''}`} aria-label={file.path}
    tabIndex={selected ? 0 : -1} data-search-result onFocus={onFocus}>
    <header className="search-card-header">
      <FileCodeIcon />
      <Link href={fileUrl(file.path, firstLine)} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(file.path, false, firstLine);
      }}><span className="search-card-path">{file.path.replace(/\\/g, '/').replace(/\/+/g, '/')}</span></Link>
      <span className="search-match-count">{file.language} · {file.matchCount.toLocaleString()} {file.matchCount === 1 ? 'match' : 'matches'}</span>
    </header>
    <div id={snippetId} className={`search-card-code ${expanded ? 'is-expanded' : ''}`}>
      <Snippet lines={lines} path={file.path} navigate={navigate} />
    </div>
    <footer className="search-card-footer">
      {allLines.length > 5 &&
        <button type="button" className="search-fold-row" aria-expanded={expanded} aria-controls={snippetId}
          onClick={() => setExpanded(value => !value)}>
          <span className="search-fold-gutter" aria-hidden="true">{expanded ? <FoldIcon size={16} /> : <UnfoldIcon size={16} />}</span>
          <span>{expanded ? 'Show less' : `Show ${allLines.length - 5} more ${allLines.length - 5 === 1 ? 'line' : 'lines'}`}</span>
        </button>}
      {file.snippetsTruncated && <Link className="search-more-matches" href={fileUrl(file.path, firstLine)} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(file.path, false, firstLine);
      }}>View all matches</Link>}
    </footer>
  </article>;
}

function Facet({ title, items, selected, onSelect, icon, languages = false }) {
  const [expanded, setExpanded] = useState(false);
  const limit = languages ? 5 : 12;
  const options = selected && !items.some(item => item.value === selected) ? [...items, { value: selected }] : items;
  const visible = expanded ? [...options] : options.slice(0, limit);
  const selectedItem = options.find(item => item.value === selected);
  if (selectedItem && !visible.includes(selectedItem)) visible.push(selectedItem);
  return <section className="search-facet">
    <h2>{title}</h2>
    <ActionList role="listbox" aria-label={title}>
      <ActionList.Item active={!selected} aria-selected={!selected} onSelect={() => onSelect('')} role="option">
        <ActionList.LeadingVisual>{React.createElement(icon)}</ActionList.LeadingVisual>
        All {title.toLowerCase()}
      </ActionList.Item>
      {visible.map(item => <ActionList.Item key={item.value} active={selected === item.value} aria-selected={selected === item.value} role="option"
        onSelect={() => onSelect(selected === item.value ? '' : item.value)}>
        <ActionList.LeadingVisual>{languages ? <LanguageSwatch language={item.value} /> : React.createElement(icon)}</ActionList.LeadingVisual>
        <span className="search-facet-value" title={item.value}>{item.value}</span>
        {item.count != null && <ActionList.TrailingVisual><CounterLabel>{item.count}</CounterLabel></ActionList.TrailingVisual>}
      </ActionList.Item>)}
    </ActionList>
    {options.length > limit && <Button size="small" variant="invisible" onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Show fewer' : `Show all ${options.length}`}
    </Button>}
  </section>;
}

async function fetchResults(params, signal) {
  const response = await fetch(`${apiBase}/search?${params}`, { signal });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

export function useCodeSearch({ config, onConfig, navigate, active, currentFile, scrollRef, scopeFilter, paths = [], pathSuggestions = [], symbols = [], onSelectSymbol }) {
  const { query, scope = '' } = config;
  const syntax = useMemo(() => {
    try { return { parsed: parseSearchQuery(query), error: '' }; }
    catch (error) { return { parsed: { text: '', languages: [], paths: [] }, error: error.message }; }
  }, [query]);
  const language = syntax.parsed.languages.at(-1) || '';
  const path = syntax.parsed.paths.at(-1)?.value || '';
  const textQuery = syntax.parsed.text;
  const pathSearch = ['files', 'bookmarks'].includes(scope);
  const symbolSearch = scope === 'symbols';
  let pathResults = [];
  if (pathSearch && !syntax.error) pathResults = filterSearchPaths(paths, query);
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
  const [result, setResult] = useState(null);
  const [activeResult, setActiveResult] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const sentinelRef = useRef(null);
  const resultListRef = useRef(null);
  const generation = useRef(0), moreRequest = useRef(null), fetchingMore = useRef(false);
  const snapshot = useRef(null);

  useEffect(() => { setActiveResult(-1); }, [result?.searchId]);

  function navigateResults(event) {
    const list = resultListRef.current;
    const cards = list?.querySelectorAll('[data-search-result]');
    if (!cards?.length) return;
    // Keep arrow keys inside links and buttons available for their own controls.
    if (event.target !== list && event.target.matches('a, button, input, [contenteditable="true"]')) return;
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
    fetchingMore.current = false;
    setLoadingMore(false); setPageError(''); setError(''); setResult(null);
    scrollRef.current?.scrollTo({ top: 0 });
    if (pathSearch || symbolSearch || !textQuery.trim() || syntax.error) { setLoading(false); setError(syntax.error); return () => controller.abort(); }
    setLoading(true);
    const identity = JSON.stringify([query, currentFile, revision, scope]);
    const params = new URLSearchParams({ q: query, scope, currentFile: currentFile || '' });
    if (snapshot.current?.identity === identity) params.set('searchId', snapshot.current.searchId);
    else params.set('refresh', 'true');
    fetchResults(params, controller.signal).then(value => {
      if (generation.current !== id || controller.signal.aborted) return;
      snapshot.current = { identity, searchId: value.searchId };
      setResult(value);
    }).catch(cause => { if (!controller.signal.aborted && generation.current === id) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted && generation.current === id) setLoading(false); });
    return () => { controller.abort(); moreRequest.current?.abort(); };
  }, [active, query, textQuery, currentFile, revision, scope, syntax.error, scrollRef, pathSearch, symbolSearch]);

  const loadMore = useCallback(async () => {
    if (pathSearch || symbolSearch || !result || result.nextOffset === null || fetchingMore.current) return;
    const id = generation.current;
    const controller = new AbortController();
    moreRequest.current = controller; fetchingMore.current = true;
    setLoadingMore(true); setPageError('');
    try {
      const params = new URLSearchParams({ q: query, scope, currentFile: currentFile || '',
        searchId: result.searchId, offset: String(result.nextOffset) });
      const page = await fetchResults(params, controller.signal);
      if (generation.current !== id || controller.signal.aborted) return;
      setResult(current => ({ ...page, files: [...current.files, ...page.files] }));
    } catch (cause) {
      if (!controller.signal.aborted && generation.current === id) setPageError(cause.message);
    } finally {
      if (generation.current === id && !controller.signal.aborted) {
        fetchingMore.current = false; setLoadingMore(false);
      }
    }
  }, [result, query, currentFile, scope, pathSearch, symbolSearch]);

  useEffect(() => {
    if (pathSearch || symbolSearch || !active || !sentinelRef.current || !result || result.nextOffset === null || pageError || loadingMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore();
    }, { root: scrollRef.current, rootMargin: '350px' });
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [active, result, loadMore, loadingMore, pageError, scrollRef, pathSearch, symbolSearch]);

  function submit(event) {
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
  function filter(kind, value) {
    try {
      const updated = updateQueryQualifier(query, kind, value);
      setDraft(updated);
      onConfig({ ...config, query: updated });
    } catch (cause) { setError(cause.message); }
  }
  function clearFilters() {
    try {
      const updated = updateQueryQualifier(updateQueryQualifier(query, 'lang', ''), 'path', '');
      setDraft(updated); onConfig({ ...config, query: updated });
    } catch (cause) { setError(cause.message); }
  }
  const sidebar = <>
    <form className="file-search code-search-form" onSubmit={submit}>
      <SearchInput size="small" block autoFocus aria-label={pathSearch ? 'Filter file names and paths' : 'Search text and code'}
        placeholder={pathSearch ? 'Filter files…' : scope === 'current-file' ? 'Search current file…' : 'Search code…'} title="Enter to search · /pattern/i · case:yes lang:js path:src/"
        clearable={Boolean(draft || query)} onClear={clearSearch}
        value={draft} maxLength={256} onChange={event => setDraft(event.target.value)} />
      {(language || path) && <div className="search-options">
        <Button variant="invisible" size="small" onClick={clearFilters}>Clear filters</Button>
      </div>}
    </form>
    <div className="tree-scroll code-search-filters" aria-label="Search filters">
      {scopeFilter}
      <Facet title="Languages" items={result ? result.facets.languages : defaultLanguages}
        selected={result?.facets.languages.find(item => normalizeLanguage(item.value) === normalizeLanguage(language))?.value || language}
        icon={CodeIcon} languages onSelect={value => filter('lang', value)} />
      <Facet title="Paths" items={result ? result.facets.paths : pathSuggestions} selected={path} icon={FileDirectoryIcon}
        onSelect={value => filter('path', value)} />
    </div>
  </>;
  const results = <section className="code-search-results" aria-label="Search results" aria-busy={loading}>
    <div className="search-results-heading" role="status" aria-live="polite">
      {loading ? <><Spinner size="small" /> Searching…</> : result ?
        <><strong>{result.total.toLocaleString()}{result.truncated ? '+' : ''} files</strong><span>· {result.matchCount.toLocaleString()}{result.truncated ? '+' : ''} matches</span></>
        : <span>{scope === 'current-file' ? `Search in ${currentFile || 'the current file'}` : !scope || scope === 'files' ? 'Search in your repository' : `Search in ${scope}`}</span>}
    </div>
    {error && <div className="search-message error" role="alert"><h2>Could not search</h2><p>{error}</p>
      <Button onClick={() => { snapshot.current = null; setRevision(value => value + 1); }}>Retry search</Button></div>}
    {result?.truncated && <p className="search-limit-notice" role="status">Results are limited. Counts cover the files found so far. Use a more specific query to find more.</p>}
    {!symbolSearch && !textQuery.trim() && !syntax.error && <SearchTips active={active} />}
    {result?.total === 0 && <div className="search-message"><p>No matching code. Try another term or clear the filters.</p></div>}
    <div className="search-result-list" ref={resultListRef} role="group" tabIndex={0} aria-label="Search results. Use the up and down arrow keys to select a file."
      onKeyDown={navigateResults}>
      {result?.files.map((file, index) => <ResultCard key={`${result.searchId}:${file.path}`} file={file} navigate={navigate}
        selected={activeResult === index} onFocus={() => setActiveResult(index)} />)}
    </div>
    {result?.nextOffset != null && <div className="search-load-more" ref={sentinelRef}>
      {pageError && <p role="alert">{pageError}</p>}
      {loadingMore ? <Spinner size="small" /> : <Button onClick={loadMore}>{pageError ? 'Retry loading' : 'Load more results'}</Button>}
    </div>}
  </section>;
  const filteredResults = <section className="code-search-results" aria-label="Filtered files">
    <div className="search-results-heading" role="status" aria-live="polite"><strong>{pathResults.length} files</strong></div>
    {syntax.error && <p className="search-message error" role="alert">{syntax.error}</p>}
    {!syntax.error && !pathResults.length && <p className="search-message">No matching files.</p>}
    <ActionList>{pathResults.map(file => <ActionList.Item key={file.path} onSelect={() => navigate(file.path)}>
      <ActionList.LeadingVisual>{scope === 'bookmarks' ? <BookmarkIcon /> : <FileCodeIcon />}</ActionList.LeadingVisual>
      {file.path}
    </ActionList.Item>)}</ActionList>
  </section>;
  const filteredSymbols = <section className="code-search-results" aria-label="Filtered symbols">
    <div className="search-results-heading" role="status" aria-live="polite"><strong>{symbolResults.length} symbols</strong></div>
    {syntax.error && <p className="search-message error" role="alert">{syntax.error}</p>}
    {!syntax.error && !symbolResults.length && <p className="search-message">{symbols.length ? 'No matching symbols.' : 'No symbols in the current document.'}</p>}
    <ActionList>{symbolResults.map(symbol => <ActionList.Item key={symbol.id} onSelect={() => onSelectSymbol?.(symbol)}>
      <ActionList.LeadingVisual><span className="search-symbol-level-icon" aria-hidden="true">H{Math.max(1, Number(symbol.level) || 1)}</span></ActionList.LeadingVisual>
      <span>{symbol.name}</span>
      <ActionList.Description>{symbol.page ? `Page ${symbol.page}` : `Line ${symbol.line}`}</ActionList.Description>
    </ActionList.Item>)}</ActionList>
  </section>;
  return { sidebar, results: pathSearch ? filteredResults : symbolSearch ? filteredSymbols : results };
}
