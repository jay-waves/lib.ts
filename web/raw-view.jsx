import React, { Suspense, use, useEffect, useMemo, useState } from 'react';
import { ActionList, ActionMenu } from '@primer/react';
import { BookmarkMenu } from './bookmarks';
import { useClipboard } from './use-clipboard';
import { loadRawHighlighter } from './raw-highlight-loader.mjs';
import './raw-view.css';

let codeFontReady;
function loadCodeFont() {
  return codeFontReady ??= window.document.fonts.load('400 13px "Iosevka"')
    .catch(() => []);
}

function HighlightedCode({ source, name }) {
  const { highlightRaw, rawLanguage } = use(loadRawHighlighter());
  const highlighted = useMemo(() => highlightRaw(source, name), [source, name, highlightRaw]);
  return <code className={`hljs language-${rawLanguage(name) || 'plaintext'}`}
    dangerouslySetInnerHTML={{ __html: highlighted }} />;
}

export function RawView({ document, targetLine, navigationRequest, bookmarkState }) {
  return <Suspense fallback={<div className="status" role="status">Loading code font…</div>}>
    <ReadyRawView document={document} targetLine={targetLine} navigationRequest={navigationRequest} bookmarkState={bookmarkState} />
  </Suspense>;
}

function ReadyRawView({ document, targetLine, navigationRequest, bookmarkState }) {
  use(loadCodeFont());
  const [selectedLine, setSelectedLine] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { copy, copied, error } = useClipboard();
  useEffect(() => { setSelectedLine(null); setMenuOpen(false); }, [targetLine, document.path, navigationRequest]);
  const source = document.source || '';
  const sourceLines = useMemo(() => source.split('\n'), [source]);
  const bookmarkedLines = useMemo(() => new Set(bookmarkState.bookmarks
    .filter(item => item.path === document.path && item.line).map(item => item.line)), [bookmarkState.bookmarks, document.path]);
  const activeLine = selectedLine ?? targetLine;
  return <><div className="raw-view" aria-label="Source code" style={{ '--selected-line': activeLine ?? 0 }} data-line-selected={activeLine > 0 || undefined}>
    <div className="raw-line-numbers">{sourceLines.map((_, index) => {
      const line = index + 1;
      const bookmarked = bookmarkedLines.has(line);
      const button = <button type="button" className="raw-line-button" aria-label={`Line ${line}${bookmarked ? ', bookmarked' : ''}`}
        aria-pressed={activeLine === line} data-bookmarked={bookmarked || undefined}
        onClick={() => { setSelectedLine(line); setMenuOpen(true); }}>{line}</button>;
      return <span key={line} id={`L${line}`} className={activeLine === line ? 'target-line' : undefined}>
        {selectedLine === line ? <ActionMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <ActionMenu.Anchor>{button}</ActionMenu.Anchor>
          <ActionMenu.Overlay><ActionList>
            <ActionList.Item onSelect={() => copy('line', sourceLines[index].replace(/\r$/, ''))}>Copy line</ActionList.Item>
            <ActionList.Item onSelect={() => copy('line link', `${location.origin}${location.pathname}?line=${line}#L${line}`)}>Copy line link</ActionList.Item>
            <BookmarkMenu state={bookmarkState} path={document.path} line={line} />
          </ActionList></ActionMenu.Overlay>
        </ActionMenu> : button}
      </span>;
    })}</div>
    <pre className="raw-code"><Suspense fallback={<code className="hljs">{source}</code>}>
      <HighlightedCode source={source} name={document.name} />
    </Suspense></pre>
  </div>{error && <div className="action-error" role="alert">{error}</div>}
    <span className="visually-hidden" role="status">{copied ? 'Copied to clipboard' : ''}</span></>;
}

