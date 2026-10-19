import type { z } from 'zod';
import { documentInfoSchema } from './api/documents.ts';
import type { ImageMetadata, VideoMetadata } from './api/media';

export type FileDescriptor = z.infer<typeof documentInfoSchema>;
export type DocumentInfo = FileDescriptor & {
  lineCount?: number;
  imageMetadata?: ImageMetadata;
  videoMetadata?: VideoMetadata;
};

// A bounded, versioned cache of server descriptions, never inferred file types.
const cacheKey = 'lib-ts:file-descriptors:v1';
const limit = 100;
type Entry = { repository: string; info: FileDescriptor };

function readEntries(): Entry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    return Array.isArray(entries) ? entries.filter(entry => typeof entry?.repository === 'string'
      && documentInfoSchema.safeParse(entry.info).success).slice(-limit) : [];
  } catch { return []; }
}

export function readDocumentInfo(repository: string, path: string): FileDescriptor | null {
  return readEntries().find(entry => entry.repository === repository && entry.info.path === path)?.info ?? null;
}

function writeEntries(entries: Entry[]) {
  try { localStorage.setItem(cacheKey, JSON.stringify(entries.slice(-limit))); } catch { /* Storage is optional. */ }
}

export function storeDocumentInfos(repository: string, files: FileDescriptor[]) {
  const entries = readEntries();
  const paths = new Set(files.map(info => info.path));
  const descriptions = files.map(info => {
    const previous = entries.find(entry => entry.repository === repository && entry.info.path === info.path)?.info;
    // A lightweight revalidation need not discard dimensions obtained by the gallery.
    return previous?.modified === info.modified && previous.size === info.size && previous.type === info.type && previous.mime === info.mime ? { ...previous, ...info } : info;
  });
  writeEntries([...entries.filter(entry => entry.repository !== repository || !paths.has(entry.info.path)),
    ...descriptions.map(info => ({ repository, info }))]);
  return descriptions;
}

export function storeDocumentInfo(repository: string, path: string, info: FileDescriptor | null) {
  if (info) return storeDocumentInfos(repository, [info])[0];
  writeEntries(readEntries().filter(entry => entry.repository !== repository || entry.info.path !== path));
  return null;
}
