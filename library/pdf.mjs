import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { init } from '@embedpdf/pdfium';
import { PdfiumNative, PdfEngine } from '@embedpdf/engines/pdfium';
import { createNodeImageDataToBufferConverter } from '@embedpdf/engines/converters';

let enginePromise;
const cache = new Map();
const opening = new Map();

async function engine() {
  enginePromise ||= init().then(module => new PdfEngine(new PdfiumNative(module), {
    imageConverter: createNodeImageDataToBufferConverter(sharp),
  })).catch(error => { enginePromise = undefined; throw error; });
  return enginePromise;
}

export function prewarmPdfEngine() { return engine(); }

export async function sweepPdfDocuments(isActive, now = Date.now(), idleMs = 15 * 60_000) {
  const entries = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, entry] of entries) {
    if (entry.inUse || isActive(entry.file)) continue;
    if (now - entry.lastUsed < idleMs && cache.size <= 3) continue;
    cache.delete(key);
    await entry.pdf.closeDocument(entry.document).toPromise();
  }
}

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

export async function pdfDocument(file, info) {
  const key = `${file}:${info.mtimeMs}:${info.size}`;
  let entry = cache.get(key);
  if (!entry) {
    if (!opening.has(key)) {
      const pending = (async () => {
        const pdf = await engine();
        const content = await readFile(file);
        const document = await pdf.openDocumentBuffer({ id: key, content }).toPromise();
        try {
          const bookmarks = await pdf.getBookmarks(document).toPromise();
          const value = { file, pdf, document, outline: outline(bookmarks.bookmarks),
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
  entry.lastUsed = Date.now();
  return { key, ...entry };
}

export async function pdfPage(file, pageNumber) {
  const info = await stat(file);
  const entry = await pdfDocument(file, info);
  const cached = cache.get(entry.key);
  cached.inUse++;
  try {
    const page = entry.document.pages[pageNumber - 1];
    if (!page) return new Response('Page not found', { status: 404 });
    const scaleFactor = Math.min(2, 1400 / page.size.width);
    const buffer = await entry.pdf.renderPage(entry.document, page, {
      scaleFactor, imageType: 'image/webp', imageQuality: .82,
    }).toPromise();
    return new Response(buffer, { headers: { 'content-type': 'image/webp', 'cache-control': 'no-store' } });
  } finally { cached.inUse--; cached.lastUsed = Date.now(); }
}
