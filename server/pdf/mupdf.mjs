import { readFile } from 'node:fs/promises';
import * as mupdf from 'mupdf';
import sharp from 'sharp';
import { pdfRasterScale, PDF_MAX_PIXELS } from '../../shared/pdf-render.mjs';

sharp.cache(false);

function outline(document) {
  const result = [], stack = (document.loadOutline() || []).toReversed().map(item => ({ item, level: 1 }));
  while (stack.length) {
    const { item, level } = stack.pop();
    const page = Number.isInteger(item.page) ? item.page
      : item.uri?.startsWith('#') ? document.resolveLink(item.uri) : -1;
    if (page >= 0) result.push({ name: item.title || '', level, page: page + 1 });
    for (const child of (item.down || []).toReversed()) stack.push({ item: child, level: level + 1 });
  }
  return result;
}

export async function openPdfDocument(file) {
  const document = mupdf.Document.openDocument(await readFile(file), 'application/pdf');
  try {
    if (document.needsPassword()) throw new Error('PDF requires a password');
    const pages = Array.from({ length: document.countPages() }, (_, index) => {
      const page = document.loadPage(index);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        return { width: x1 - x0, height: y1 - y0 };
      } finally { page.destroy(); }
    });
    return {
      pages, outline: outline(document),
      async render(index, targetWidth) {
        const page = document.loadPage(index);
        let pixmap, device;
        try {
          const [x0, y0, x1, y1] = page.getBounds();
          const scale = pdfRasterScale(x1 - x0, y1 - y0, targetWidth);
          const width = Math.max(1, Math.round((x1 - x0) * scale));
          const height = Math.max(1, Math.round((y1 - y0) * scale));
          if (width * height > PDF_MAX_PIXELS) throw new Error('PDF raster exceeds pixel budget');
          pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true);
          pixmap.clear(255);
          device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
          const sx = width / (x1 - x0), sy = height / (y1 - y0);
          page.run(device, [sx, 0, 0, sy, -x0 * sx, -y0 * sy]);
          device.close();
          const pixels = pixmap.getPixels();
          return await sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
            { raw: { width, height, channels: 4 } }).webp({ quality: 92 }).toBuffer();
        } finally {
          device?.destroy(); pixmap?.destroy(); page.destroy();
        }
      },
      close: () => document.destroy(),
    };
  } catch (error) { document.destroy(); throw error; }
}
