import { useEffect, useRef, useState } from 'react';
import { watchDocument } from './api/documents.ts';
import { apiBase } from './urls.mjs';
import { changedAssetPaths } from './document-content.ts';

export function useReaderWatch(document, assets, active, onReload) {
  const { path } = document;
  const [versions, setVersions] = useState({});
  const reload = useRef(onReload);
  const assetSnapshot = useRef({});
  reload.current = onReload;
  const assetKey = assets.join('\0');
  useEffect(() => {
    if (!active) return;
    const paths = assetKey.split('\0').filter(Boolean);
    const invalidate = changed => changed.length && setVersions(previous => {
      const next = { ...previous }, now = Date.now();
      for (const file of changed) next[file] = now;
      return next;
    });
    // Every format revalidates in the background; useDocument retains unchanged
    // content. Asset snapshots catch edits missed while the watcher was paused.
    const stream = watchDocument(apiBase, path, paths, {
      document: () => reload.current(),
      connected: ({ assets }) => {
        invalidate(changedAssetPaths(assetSnapshot.current, assets));
        assetSnapshot.current = assets;
        reload.current();
      },
      assets: ({ paths }) => invalidate(paths),
    });
    return () => stream.close();
  }, [path, assetKey, active]);
  return versions;
}
