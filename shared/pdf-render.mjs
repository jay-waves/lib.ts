export const PDF_PAGE_WIDTH = 900;
export const PDF_MAX_PIXELS = 8_000_000;

export function pdfRenderWidth(scale = 1, dpr = 2) {
  const width = PDF_PAGE_WIDTH * scale * Math.max(2, Math.min(3, dpr));
  return normalizePdfWidth(width);
}

export function normalizePdfWidth(width = 1800) {
  return Math.min(3600, Math.max(450, Math.ceil(width / 450) * 450));
}

export function pdfRasterScale(width, height, targetWidth) {
  const scale = Math.min(targetWidth / width, Math.sqrt(PDF_MAX_PIXELS / (width * height)));
  // Both output dimensions are rounded; keep them within the pixel budget.
  if (Math.max(1, Math.round(width * scale)) * Math.max(1, Math.round(height * scale)) <= PDF_MAX_PIXELS) return scale;
  return Math.min(scale, Math.max(1, Math.floor(width * scale)) / width,
    Math.max(1, Math.floor(height * scale)) / height);
}
