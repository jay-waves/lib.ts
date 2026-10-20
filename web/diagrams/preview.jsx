import React, { useEffect, useRef } from 'react';
import { mountDiagram } from './mount.mjs';

export function DiagramPreview({ source, name }) {
  const container = useRef(null);
  useEffect(() => mountDiagram(container.current, source), [source]);
  return <div className="diagram-document"><div ref={container} className="diagram-view" aria-label={name} /></div>;
}
