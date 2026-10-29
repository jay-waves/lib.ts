import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { watchDocument } from './api/documents.ts';
import { apiBase } from './urls.mjs';
import { changedAssetPaths } from './document-content.ts';

export function useReaderWatch(path, modified, assets, active, onReload, revalidateDependencies = false) {
  const [versions, setVersions] = useState({});
  const reload = useEffectEvent(onReload);
  const assetSnapshot = useRef({});
  const checkVersion = useEffectEvent(serverModified => {
    // Recompile after the subscription exists: a dependency may have changed
    // between the HTTP compilation and this first SSE snapshot.
    if ((modified && modified !== serverModified) || revalidateDependencies) reload();
  });
  const assetKey = assets.join('\0');
  useEffect(() => {
    if (!active) return;
    const paths = assetKey.split('\0').filter(Boolean);
    const invalidate = changed => changed.length && setVersions(previous => {
      const next = { ...previous }, now = Date.now();
      for (const file of changed) next[file] = now;
      return next;
    });
    // The connection snapshot closes the HTTP/SSE gap without reloading unchanged files.
    const stream = watchDocument(apiBase, path, paths, {
      document: () => reload(),
      connected: ({ modified, assets }) => {
        invalidate(changedAssetPaths(assetSnapshot.current, assets));
        assetSnapshot.current = assets;
        checkVersion(modified);
      },
      assets: ({ paths }) => invalidate(paths),
    });
    return () => stream.close();
  }, [path, assetKey, active]);
  return versions;
}
