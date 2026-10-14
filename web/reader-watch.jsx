import { useEffect, useRef, useState } from 'react';
import { visibleEvents } from './visible-events.mjs';
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
    const query = new URLSearchParams({ path });
    for (const asset of paths) query.append('asset', asset);
    const invalidate = changed => setVersions(previous => {
      const next = { ...previous }, now = Date.now();
      for (const file of changed) next[file] = now;
      return next;
    });
    const changed = () => { invalidate([path, ...paths]); reload.current(); };
    // The server reports the source revision after subscribing. Markdown only
    // needs a refetch if that revision changed; other formats may depend on
    // imports, so retain their full reconnect refresh.
    const stream = visibleEvents(`${apiBase}/library/events?${query}`, {
      document: changed,
      connected: event => {
        invalidate([path, ...paths]);
        if (!revision.current || JSON.parse(event.data).modified !== revision.current) reload.current();
      },
      assets: event => invalidate(JSON.parse(event.data).paths || []),
    });
    return () => stream.close();
  }, [path, assetKey, active]);
  return versions;
}
