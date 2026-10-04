import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { init } from '@embedpdf/pdfium';
import { PdfiumNative, PdfEngine } from '@embedpdf/engines/pdfium';
import { createNodeImageDataToBufferConverter } from '@embedpdf/engines/converters';

let enginePromise;

async function engine() {
  enginePromise ||= init().then(module => new PdfEngine(new PdfiumNative(module), {
    imageConverter: createNodeImageDataToBufferConverter(sharp),
  })).catch(error => { enginePromise = undefined; throw error; });
  return enginePromise;
}

export function prewarmPdfEngine() { return engine(); }

function outline(bookmarks, level = 1, result = []) {
  for (const bookmark of bookmarks || []) {
    const destination = bookmark.target?.destination || bookmark.target?.action?.destination;
    if (destination && Number.isInteger(destination.pageIndex)) result.push({
      name: bookmark.title, level, page: destination.pageIndex + 1,
    });
    outline(bookmark.children, level + 1, result);
  }
  return result;
}

export function createPdfStore(getEngine = engine) {
  const cache = new Map(), opening = new Map();
  let generation = 0;

  async function acquire(file, info) {
    const key = `${file}:${info.mtimeMs}:${info.size}`;
    let entry = cache.get(key);
    if (!entry) {
      if (!opening.has(key)) {
        const revision = ++generation;
        const pending = (async () => {
          const pdf = await getEngine();
          const content = await readFile(file);
          const document = await pdf.openDocumentBuffer({ id: key, content }).toPromise();
          try {
            const bookmarks = await pdf.getBookmarks(document).toPromise();
            const value = { key, file, pdf, document, generation: revision, outline: outline(bookmarks.bookmarks),
              pages: document.pages.map(page => ({ width: page.size.width, height: page.size.height })),
              lastUsed: Date.now(), inUse: 0 };
            cache.set(key, value);
            return value;
          } catch (error) {
            await pdf.closeDocument(document).toPromise();
            throw error;
          }
        })();
        opening.set(key, pending);
        pending.finally(() => opening.delete(key)).catch(() => {});
      }
      entry = await opening.get(key);
    }
    // Do not reuse a native document while its asynchronous close is running.
    if (entry.closing) { await entry.closing; return acquire(file, info); }
    entry.inUse++;
    entry.lastUsed = Date.now();
    return entry;
  }
  function release(entry) { entry.inUse--; entry.lastUsed = Date.now(); }

  return {
    async document(file, info) {
      const entry = await acquire(file, info);
      try { return { key: entry.key, outline: entry.outline, pages: entry.pages }; }
      finally { release(entry); }
    },
    async page(file, pageNumber) {
      const entry = await acquire(file, await stat(file));
      try {
        const page = entry.document.pages[pageNumber - 1];
        if (!page) return new Response('Page not found', { status: 404 });
        const scaleFactor = Math.min(2, 1400 / page.size.width);
        const buffer = await entry.pdf.renderPage(entry.document, page, {
          scaleFactor, imageType: 'image/webp', imageQuality: .82,
        }).toPromise();
        return new Response(buffer, { headers: { 'content-type': 'image/webp', 'cache-control': 'no-store' } });
      } finally { release(entry); }
    },
    async sweep(isActive, now = Date.now(), idleMs = 5 * 60_000) {
      const latest = new Map();
      for (const entry of cache.values()) {
        if (!latest.has(entry.file) || latest.get(entry.file).generation < entry.generation) latest.set(entry.file, entry);
      }
      const entries = [...cache.values()].sort((a, b) => a.lastUsed - b.lastUsed);
      for (const entry of entries) {
        if (cache.get(entry.key) !== entry || entry.inUse || entry.closing) continue;
        const current = latest.get(entry.file) === entry;
        if (current && isActive(entry.file)) continue;
        const idle = now - entry.lastUsed;
        if (idle < idleMs && cache.size <= 3 && (current || idle < 60_000)) continue;
        // Mark before awaiting, so overlapping sweeps cannot close twice.
        entry.closing = entry.pdf.closeDocument(entry.document).toPromise().then(() => {
          if (cache.get(entry.key) === entry) cache.delete(entry.key);
        }, error => { entry.closing = null; throw error; });
        await entry.closing;
      }
    },
  };
}

const documents = createPdfStore();
export const pdfDocument = documents.document;
export const pdfPage = documents.page;
export const sweepPdfDocuments = documents.sweep;
