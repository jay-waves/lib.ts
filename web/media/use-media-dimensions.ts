import { useCallback, useState } from 'react';
import type { DocumentInfo } from '../document-info';

type Dimensions = { width: number; height: number };

// Backend dimensions are a placeholder; the displayed media has the final say.
export function useMediaDimensions(document: DocumentInfo | null) {
  const key = document ? JSON.stringify([document.path, document.modified]) : '';
  const [measured, setMeasured] = useState<{ key: string; dimensions: Dimensions } | null>(null);
  const report = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setMeasured(previous => previous?.key === key
      && previous.dimensions.width === width && previous.dimensions.height === height
      ? previous : { key, dimensions: { width, height } });
  }, [key]);
  const fallback = document?.imageMetadata?.dimensions ?? document?.videoMetadata?.dimensions ?? document?.dimensions;
  return { dimensions: measured?.key === key ? measured.dimensions : fallback, report };
}
