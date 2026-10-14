// Owned by the serialized PDF worker: no overlapping open, render or close.
import { stat } from 'node:fs/promises';
import { normalizePdfWidth } from '../../shared/pdf-render.mjs';
import { openPdfDocument } from './mupdf.mjs';

export function createPdfStore(openDocument = openPdfDocument) {
  const documents = new Map();
  async function acquire(file, info) {
    const key = `${file}:${info.mtimeMs}:${info.size}`;
    let entry = documents.get(key);
    if (!entry) {
      entry = { key, file, document: await openDocument(file) };
      documents.set(key, entry);
    }
    entry.lastUsed = Date.now();
    return entry;
  }
  return {
    async document(file, info) {
      const entry = await acquire(file, info);
      return { key: entry.key, outline: entry.document.outline, pages: entry.document.pages };
    },
    async page(file, pageNumber, width = 1800, info) {
      const { document } = await acquire(file, info || await stat(file));
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.pages.length)
        return { status: 404, body: new ArrayBuffer(0) };
      const bytes = await document.render(pageNumber - 1, normalizePdfWidth(width));
      return { status: 200, body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    async sweep(isActive, now = Date.now(), idleMs = 5 * 60_000) {
      const latest = new Map();
      for (const entry of documents.values()) latest.set(entry.file, entry);
      for (const entry of [...documents.values()].sort((a, b) => a.lastUsed - b.lastUsed)) {
        const current = latest.get(entry.file) === entry;
        if (current && isActive(entry.file)) continue;
        const idle = now - entry.lastUsed;
        if (idle < idleMs && documents.size <= 3 && (current || idle < 60_000)) continue;
        await entry.document.close();
        documents.delete(entry.key);
      }
    },
  };
}
