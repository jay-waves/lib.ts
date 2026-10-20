import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMediaDimensions } from '../api/media';
import { apiBase } from '../urls.mjs';
import { storeDocumentInfos } from '../document-info';
import type { DirectorySort, GalleryImage } from './gallery-images';
import { createGalleryLoader, type GalleryItem } from './gallery-media';

type GalleryState = { source: GalleryImage[]; sort: DirectorySort; items: GalleryItem[]; error: string };

export function useGalleryMedia(candidates: GalleryImage[], sort: DirectorySort) {
  const [state, setState] = useState<GalleryState | null>(null);
  const next = useRef(() => {});
  const loadMore = useCallback(() => next.current(), []);
  useEffect(() => {
    if (!candidates.length) return;
    const controller = new AbortController();
    const loader = createGalleryLoader(candidates, sort,
      (paths, signal, capture) => getMediaDimensions(apiBase, paths, signal, capture),
      update => {
        // Cache the displayed batch, including when capture-date sorting reused
        // descriptors fetched earlier in a different order.
        storeDocumentInfos(apiBase, update.files);
        setState({ source: candidates, sort, items: update.items, error: update.error });
      }, controller.signal);
    next.current = () => { void loader.loadMore(); };
    void loader.start();
    return () => { controller.abort(); next.current = () => {}; };
  }, [candidates, sort]);

  const current = state?.source === candidates && state.sort === sort ? state : null;
  return useMemo(() => ({
    images: current?.items.map(item => item.node) ?? [],
    ratios: current?.items.map(item => item.ratio) ?? [],
    loading: candidates.length > 0 && !current,
    hasMore: (current?.items.length ?? 0) < candidates.length,
    error: current?.error ?? '',
    loadMore,
  }), [current, candidates.length, loadMore]);
}
