import { useEffect } from 'react';
import { retainDocument } from './document-session.mjs';

export function useDocumentLease(endpoint: string, path: string) {
  useEffect(() => path ? retainDocument(endpoint, path) : undefined, [endpoint, path]);
}
