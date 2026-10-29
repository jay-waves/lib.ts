import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { enableDiagramZoom } from './zoom.mjs';
import './diagram.css';
import '../../crates/lib-comrak/mermaid.css';

export function DiagramPreview({ html, name }) {
  const container = useRef(null);
  useEffect(() => {
    const target = container.current;
    target.replaceChildren(DOMPurify.sanitize(html || '', {
      USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
    }));
    return enableDiagramZoom(target);
  }, [html]);
  return <div className="diagram-document"><div ref={container} className="diagram-view" aria-label={name} /></div>;
}
