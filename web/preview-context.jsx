import { createContext, useContext } from 'react';

// Rendering and viewport data are shared by documents and standalone media.
// Reading progress, source navigation and prepared Markdown belong to Reader.
export const PreviewContext = createContext(null);

export function usePreview() {
  const preview = useContext(PreviewContext);
  if (!preview) throw new Error('Preview components must be mounted inside a preview surface');
  return preview;
}
