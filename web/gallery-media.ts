import { mediaKey, sortDirectoryNodes, type DirectorySort, type GalleryImage } from './gallery-images.ts';
import { galleryBatchSize } from './gallery-layout.mjs';
import type { FileDescriptor } from './document-info';

type Metadata = { files: FileDescriptor[] };
export type GalleryItem = { node: GalleryImage; ratio: number };
type Update = { items: GalleryItem[]; error: string; files: FileDescriptor[] };
export const galleryMetadataConcurrency = 4;
export const galleryMetadataRequestSize = 16;

// One loader owns ordering, metadata and its cursor. Each call prepares at most
// 64 cards; the view decides when another batch is needed.
export function createGalleryLoader(candidates: GalleryImage[], sort: DirectorySort,
  request: (paths: string[], signal: AbortSignal, capture?: boolean) => Promise<Metadata>,
  publish: (update: Update) => void, signal: AbortSignal) {
  const files: Record<string, FileDescriptor> = {};
  let ordered = sortDirectoryNodes(candidates, sort);
  let items: GalleryItem[] = [];
  let busy = false;
  let initialized = false;
  let error = '';

  // Keep the 64-card layout batches stable, but read their metadata through
  // smaller concurrent requests so one slow file cannot serialize the batch.
  const readMetadata = async (nodes: GalleryImage[], capture = false) => {
    let cursor = 0;
    let failed = false;
    await Promise.all(Array.from({ length: Math.min(galleryMetadataConcurrency,
      Math.ceil(nodes.length / galleryMetadataRequestSize)) }, async () => {
      while (!signal.aborted) {
        const batch = nodes.slice(cursor, cursor + galleryMetadataRequestSize);
        cursor += galleryMetadataRequestSize;
        if (!batch.length) return;
        try {
          const response = await request(batch.map(node => node.path), signal, capture);
          if (signal.aborted) return;
          for (const file of response.files) files[file.path] = file;
        } catch (cause) {
          if (signal.aborted) return;
          failed = true;
          console.warn('Could not load gallery metadata', cause);
        }
      }
    }));
    return !failed;
  };

  const loadBatch = async () => {
    if (busy || signal.aborted || items.length >= ordered.length) return;
    busy = true;
    const batch = ordered.slice(items.length, items.length + galleryBatchSize);
    const missing = batch.filter(node => !Object.hasOwn(files, node.path));
    if (!await readMetadata(missing)) {
      error = 'Some media dimensions could not be read. Using fixed card proportions.';
    }
    if (signal.aborted) return;
    items = [...items, ...batch.map(node => {
      const info = files[node.path], size = info?.dimensions;
      return { node: info ? { ...node, modified: info.modified, mime: info.mime, media: info.media, playable: info.playable } : node,
        ratio: size ? size.width / size.height : 4 / 3 };
    })];
    publish({ items, error, files: batch.flatMap(node => files[node.path] ? [files[node.path]] : []) });
    busy = false;
  };

  const start = async () => {
    if (signal.aborted) return;
    // Dates determine the global order. Resolve them once before revealing
    // cards, then prepare only the requested batches from the cached sizes.
    if (sort.startsWith('taken-')) {
      const dates: Record<string, number | null> = {};
      if (await readMetadata(candidates, true)) {
        if (signal.aborted) return;
        for (const node of candidates) dates[mediaKey(node)] = files[node.path]?.capturedAt ?? null;
        ordered = sortDirectoryNodes(candidates, sort, dates);
      } else {
        error = 'Could not load capture dates. Using modification times.';
      }
    }
    if (signal.aborted) return;
    initialized = true;
    await loadBatch();
  };
  return { start, loadMore: async () => { if (initialized) await loadBatch(); } };
}
