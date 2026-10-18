import React from 'react';
import { useDocumentViewport } from './use-document-viewport.jsx';
import './document-viewport.css';

export function DocumentPreview({ layout, children }) {
  const { ref, scale } = useDocumentViewport(layout);
  return <div ref={ref} className="document-viewer" data-zoomed={scale > 1 ? '' : undefined} role="region" aria-label="Document preview">
    <div className="document-stage">{children}</div>
  </div>;
}
