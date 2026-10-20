import React from 'react';
import { DiagramPreview } from './diagrams/preview.jsx';
import './html-preview.css';
import { DocumentPreview } from './document-preview.jsx';
import { TypstPages } from './typst/typst-view.jsx';
import { PdfPages } from './pdf/pdf-view.jsx';
import { pagedDocumentLayout } from './document-preview.mjs';
import { usePreview } from './preview-context.jsx';

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

function TypstPreview() {
  const { document, viewport, onExpired } = usePreview();
  return <DocumentPreview layout={pagedDocumentLayout(document.pages)}>
    <div className="typst-pages document-pages">
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
      <TypstPages pages={document.pages || []} scale={viewport.scale} onExpired={onExpired} />
    </div>
  </DocumentPreview>;
}

export function Preview() {
  const { document, viewport } = usePreview();
  if (document.type === 'mermaid') return <DiagramPreview source={document.source} name={document.name} />;
  if (document.type === 'typst') return <TypstPreview />;
  if (document.type === 'pdf') return <DocumentPreview layout={pagedDocumentLayout(document.pages)}>
    <PdfPages key={`${document.path}:${document.revision || document.modified}`} pages={document.pages}
      scale={viewport.scale} modified={document.modified} revision={document.revision || document.modified} />
  </DocumentPreview>;
  if (document.type === 'html') return <iframe className="html-preview" aria-label={document.name}
    sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    src={`${document.url}&v=${encodeURIComponent(document.modified)}`} />;
  if (document.type === 'binary') return <div className="status"><p>{document.format?.toUpperCase() || 'Binary file'} · {document.mime}</p><p>Preview is unavailable for this format.</p><a href={document.url} download={document.name}>Download file</a></div>;
  return <pre className="text-preview">{document.source}</pre>;
}
