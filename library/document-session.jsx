import { useEffect } from 'react';
import { retainDocument } from './document-session.mjs';

export function useDocumentLease(endpoint, path) {
  useEffect(() => path ? retainDocument(endpoint, path) : undefined, [endpoint, path]);
}
