import { useEffect, useRef, useState } from 'react';
import { watchDocument } from './api/documents.ts';
import { apiBase } from './urls.mjs';

export function useReaderWatch(document, assets, active, onReload) {
  const { path } = document;
  const [versions, setVersions] = useState({});
  const reload = useRef(onReload);
  const revision = useRef(null);
  reload.current = onReload;
  revision.current = document.type === 'markdown' ? document.modified : null;
  const assetKey = assets.join('\0');
  useEffect(() => {
    if (!active) return;
    const paths = assetKey.split('\0').filter(Boolean);
    const invalidate = changed => setVersions(previous => {
      const next = { ...previous }, now = Date.now();
      for (const file of changed) next[file] = now;
      return next;
    });
    const changed = () => { invalidate([path, ...paths]); reload.current(); };
    // The server reports the source revision after subscribing. Markdown only
    // needs a refetch if that revision changed; other formats may depend on
    // imports, so retain their full reconnect refresh.
    const stream = watchDocument(apiBase, path, paths, {
      document: changed,
      connected: ({ modified }) => {
        invalidate([path, ...paths]);
        if (!revision.current || modified !== revision.current) reload.current();
      },
      assets: ({ paths }) => invalidate(paths),
    });
    return () => stream.close();
  }, [path, assetKey, active]);
  return versions;
}
