import React, { useMemo } from 'react';
import { highlightRaw, rawLanguage } from './raw-highlight.mjs';

export function RawView({ document, targetLine }) {
  const source = document.source || '';
  const language = rawLanguage(document.name);
  const highlighted = useMemo(() => highlightRaw(source, document.name), [document.name, source]);
  const lines = Math.max(1, source.split('\n').length);
  return <div className="raw-view" aria-label="Source code">
    <div className="raw-line-numbers" aria-hidden="true">{Array.from({ length: lines }, (_, index) => <span key={index} id={`L${index + 1}`} className={targetLine === index + 1 ? 'target-line' : undefined}>{index + 1}</span>)}</div>
    <pre className="raw-code"><code className={`hljs language-${language || 'plaintext'}`}
      dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
  </div>;
}

