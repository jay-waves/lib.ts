import React, { Suspense, use, useMemo } from 'react';
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

export function RawView({ document, targetLine }) {
  return <Suspense fallback={<div className="status" role="status">Loading code font…</div>}>
    <ReadyRawView document={document} targetLine={targetLine} />
  </Suspense>;
}

function ReadyRawView({ document, targetLine }) {
  use(loadCodeFont());
  const source = document.source || '';
  const lines = Math.max(1, source.split('\n').length);
  return <div className="raw-view" aria-label="Source code">
    <div className="raw-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index} id={`L${index + 1}`} className={targetLine === index + 1 ? 'target-line' : undefined}>{index + 1}</span>)}</div>
    <pre className="raw-code"><Suspense fallback={<code className="hljs">{source}</code>}>
      <HighlightedCode source={source} name={document.name} />
    </Suspense></pre>
  </div>;
}

