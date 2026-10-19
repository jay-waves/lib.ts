import { useEffect, useState } from 'react';
import { getMediaMetadata } from './api/media';
import type { DocumentInfo } from './document-info';

export function useMediaInfo(apiBase: string, info: DocumentInfo | null, active: boolean) {
  const [metadata, setMetadata] = useState<Awaited<ReturnType<typeof getMediaMetadata>> | null>(null);
  const path = info?.path, modified = info?.modified;
  const inspect = Boolean(info?.media && info.mime !== 'image/svg+xml');
  useEffect(() => {
    if (!active || !inspect || !path || (metadata?.path === path && metadata.modified === modified)) return;
    const controller = new AbortController();
    void getMediaMetadata(apiBase, path, controller.signal).then(value => {
      if (!controller.signal.aborted) setMetadata(value);
    }).catch(() => {}); // Optional details never block playback or image decoding.
    return () => controller.abort();
  }, [apiBase, path, modified, inspect, active]);
  if (!info || !metadata || metadata.path !== path || metadata.modified !== modified || metadata.media.kind !== info.media) return info;
  return { ...info, ...(metadata.media.kind === 'image'
    ? { imageMetadata: metadata.media.details } : { videoMetadata: metadata.media.details }) };
}
