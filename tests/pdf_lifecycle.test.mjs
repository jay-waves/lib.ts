import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfDocument, pdfPage, prewarmPdfEngine, sweepPdfDocuments } from '../library/pdf.mjs';

function blankPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

test('PDFium prewarm leaves documents unopened and idle documents reopen on demand', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pdf-lifecycle-'));
  const file = join(directory, 'blank.pdf');
  try {
    await writeFile(file, blankPdf());
    await prewarmPdfEngine();
    const info = await stat(file);
    const document = await pdfDocument(file, info);
    assert.equal(document.pages.length, 1);
    assert.equal((await pdfPage(file, 1)).status, 200);
    await sweepPdfDocuments(() => false, Date.now() + 60_000, 0);
    assert.equal((await pdfPage(file, 1)).status, 200);
    await sweepPdfDocuments(() => false, Date.now() + 60_000, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
