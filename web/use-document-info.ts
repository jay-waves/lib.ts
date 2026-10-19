import { useEffect, useState } from 'react';
import { getDocumentInfo } from './api/documents';
import { ApiError } from './api/client';
import { readDocumentInfo, storeDocumentInfo } from './document-info';

// The owning FilePage is keyed by path. Cached descriptions paint immediately;
// each visit and file notification checks the server before starting new work.
export function useDocumentInfo(apiBase: string, path: string, active: boolean, revision: number) {
  const [info, setInfo] = useState(() => readDocumentInfo(apiBase, path));
  const [checkedRevision, setCheckedRevision] = useState(-1);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError('');
    void getDocumentInfo(apiBase, path, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const description = storeDocumentInfo(apiBase, path, value);
      setInfo(previous => JSON.stringify(previous) === JSON.stringify(description) ? previous : description);
      setCheckedRevision(revision);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [400, 404].includes(cause.status)) {
        storeDocumentInfo(apiBase, path, null);
        setInfo(null);
        setCheckedRevision(-1);
      }
      setError(String(cause));
    });
    return () => controller.abort();
  }, [apiBase, path, active, revision]);
  return { info, confirmed: checkedRevision >= 0, ready: checkedRevision === revision, error };
}
