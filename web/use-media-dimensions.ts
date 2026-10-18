import { useCallback, useState } from 'react';
import type { LibraryDocument } from './api/documents';

type Dimensions = { width: number; height: number };

// Backend dimensions are a placeholder; the displayed media has the final say.
export function useMediaDimensions(document: LibraryDocument | null) {
  const key = document ? JSON.stringify([document.path, document.modified]) : '';
  const [measured, setMeasured] = useState<{ key: string; dimensions: Dimensions } | null>(null);
  const report = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setMeasured(previous => previous?.key === key
      && previous.dimensions.width === width && previous.dimensions.height === height
      ? previous : { key, dimensions: { width, height } });
  }, [key]);
  const fallback = document?.type === 'image' ? document.imageMetadata?.dimensions
    : document?.type === 'binary' ? document.videoMetadata?.dimensions : undefined;
  return { dimensions: measured?.key === key ? measured.dimensions : fallback, report };
}
