import { mediaKey, sortDirectoryNodes, type DirectorySort, type GalleryImage } from './gallery-images.ts';
import { galleryBatchSize } from './gallery-layout.mjs';

type Size = { width: number; height: number } | null;
type Metadata = { dimensions: Record<string, Size>; capturedAt: Record<string, number | null> };
export type GalleryItem = { node: GalleryImage; ratio: number };
type Update = { items: GalleryItem[]; error: string };

// One loader owns ordering, metadata and its cursor. Each call prepares at most
// 64 cards; the view decides when another batch is needed.
export function createGalleryLoader(candidates: GalleryImage[], sort: DirectorySort,
  request: (paths: string[], signal: AbortSignal, capture?: boolean) => Promise<Metadata>,
  publish: (update: Update) => void, signal: AbortSignal) {
  const dimensions: Record<string, Size> = {};
  let ordered = sortDirectoryNodes(candidates, sort);
  let items: GalleryItem[] = [];
  let busy = false;
  let initialized = false;
  let error = '';

  const loadBatch = async () => {
    if (busy || signal.aborted || items.length >= ordered.length) return;
    busy = true;
    const batch = ordered.slice(items.length, items.length + galleryBatchSize);
    const missing = batch.filter(node => !Object.hasOwn(dimensions, node.path));
    try {
      if (missing.length) {
        const response = await request(missing.map(node => node.path), signal);
        Object.assign(dimensions, response.dimensions);
      }
    } catch (cause) {
      if (signal.aborted) return;
      console.warn('Could not load gallery dimensions', cause);
      error = 'Some media dimensions could not be read. Using fixed card proportions.';
    }
    if (signal.aborted) return;
    items = [...items, ...batch.map(node => {
      const size = dimensions[node.path];
      return { node, ratio: size ? size.width / size.height : 4 / 3 };
    })];
    publish({ items, error });
    busy = false;
  };

  const start = async () => {
    if (signal.aborted) return;
    // Dates determine the global order. Resolve them once before revealing
    // cards, then prepare only the requested batches from the cached sizes.
    if (sort.startsWith('taken-')) {
      const dates: Record<string, number | null> = {};
      try {
        for (let index = 0; index < candidates.length; index += galleryBatchSize) {
          const batch = candidates.slice(index, index + galleryBatchSize);
          const response = await request(batch.map(node => node.path), signal, true);
          if (signal.aborted) return;
          Object.assign(dimensions, response.dimensions);
          for (const node of batch) dates[mediaKey(node)] = response.capturedAt[node.path] ?? null;
        }
        ordered = sortDirectoryNodes(candidates, sort, dates);
      } catch (cause) {
        if (signal.aborted) return;
        console.warn('Could not load gallery capture dates', cause);
        error = 'Could not load capture dates. Using modification times.';
      }
    }
    if (signal.aborted) return;
    initialized = true;
    await loadBatch();
  };
  return { start, loadMore: async () => { if (initialized) await loadBatch(); } };
}
