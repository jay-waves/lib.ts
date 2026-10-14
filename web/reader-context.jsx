import { createContext, useContext } from 'react';

export const ReaderContext = createContext(null);

export function useReader() {
  const reader = useContext(ReaderContext);
  if (!reader) throw new Error('Reader components must be mounted inside Reader');
  return reader;
}
