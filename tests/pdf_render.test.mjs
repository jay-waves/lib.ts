import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfRenderWidth, pdfRasterScale, PDF_MAX_PIXELS } from '../web/pdf/render.ts';

test('PDF pixel width follows zoom and DPR with stable cache buckets', () => {
  assert.equal(pdfRenderWidth(1, 1), 1800);
  assert.equal(pdfRenderWidth(1, 2), 1800);
  assert.equal(pdfRenderWidth(1.25, 2), 2250);
  assert.equal(pdfRenderWidth(1, 3), 2700);
  assert.equal(pdfRenderWidth(1.01, 2), pdfRenderWidth(1.1, 2));
  assert.equal(pdfRenderWidth(10, 10), 3600);
});

test('PDF raster scale preserves requested detail and bounds enlarged or unusual pages', () => {
  assert.equal(pdfRasterScale(595, 842, 1800), 1800 / 595);
  for (const [width, height] of [[595, 842], [100, 1_000_000], [1_000_000, 100]]) {
    const scale = pdfRasterScale(width, height, 3600);
    assert.ok(width * height * scale ** 2 <= PDF_MAX_PIXELS + 1);
    assert.ok(Math.max(1, Math.round(width * scale)) * Math.max(1, Math.round(height * scale)) <= PDF_MAX_PIXELS);
  }
});
