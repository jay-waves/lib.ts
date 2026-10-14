import React from 'react';
import { useDocumentViewport } from './use-document-viewport.jsx';
import './document-viewport.css';

export function DocumentPreview({ layout, children }) {
  const { ref, scale } = useDocumentViewport(layout);
  return <div className="document-viewer">
    <div ref={ref} className="document-viewport" tabIndex={0} role="region" aria-label="Document preview">
      <div className="document-stage" style={{ width: `max(100%, ${layout.contentWidth * scale + 48}px)` }}>
        {children}
      </div>
    </div>
  </div>;
}
