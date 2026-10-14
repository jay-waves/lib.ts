import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import * as mupdf from 'mupdf';
import { renderMarkdown } from '../../server/markdown/renderer.mjs';
import { openPdfDocument } from '../../server/pdf/mupdf.mjs';
import { analyzeTypst } from '../../server/typst/tree.mjs';
import { createTypstEngine } from '../../server/typst/engine.mjs';

const iterations = Math.max(1, Number.parseInt(process.env.JS_BACKEND_PERF_ITERATIONS || '15', 10));

function fixturePdf(pageCount) {
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageCount} >>`),
  ];
  for (let index = 0; index < pageCount; index++) {
    const pageId = 3 + index * 2, contentId = pageId + 1;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents ${contentId} 0 R >>`));
    let content = 'q\n';
    for (let line = 0; line < 80; line++) content += `0.2 0.4 0.8 rg 40 ${20 + line * 9} 480 1 re f\n`;
    content += 'Q\n';
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`));
  }

  const parts = [Buffer.from('%PDF-1.7\n')], offsets = [];
  let length = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length);
    const item = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from('\nendobj\n')]);
    parts.push(item); length += item.length;
  }
  const xrefOffset = length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function memoryKb() {
  const usage = process.memoryUsage();
  return Math.round(usage.rss / 1024);
}

function peakMemoryKb() {
  const value = process.resourceUsage().maxRSS;
  return process.platform === 'darwin' ? Math.round(value / 1024) : value;
}

async function measure(stage, inputBytes, count, outputUnit, operation) {
  const samples = [];
  let outputSize = 0;
  for (let index = 0; index < count; index++) {
    const start = performance.now();
    outputSize = await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const percentile = p => samples[Math.ceil((samples.length - 1) * p)];
  return { stage, input_bytes: inputBytes, iterations: count,
    p50_ms: percentile(0.5), p95_ms: percentile(0.95), min_ms: samples[0],
    output_size: outputSize, output_unit: outputUnit };
}

async function main() {
  const rssBefore = memoryKb(), peakBefore = peakMemoryKb();
  const markdownSource = await readFile('tests/fixtures/backend-perf.md', 'utf8');
  const typstSource = await readFile('tests/fixtures/backend-perf.typ', 'utf8');
  const pdfBytes = fixturePdf(12);
  const temporary = await mkdtemp(join(tmpdir(), 'backend-perf-js-'));
  const pdfPath = join(temporary, 'backend-perf.pdf');
  const typstRoot = join(temporary, 'typst');
  const typstPath = join(typstRoot, 'backend-perf.typ');
  await writeFile(pdfPath, pdfBytes);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(typstRoot, { recursive: true });
  await writeFile(typstPath, typstSource);

  const results = [];
  try {
    results.push(await measure('pdf_parse', pdfBytes.length, iterations, 'pages', () => {
      const document = mupdf.Document.openDocument(pdfBytes, 'application/pdf');
      try { return document.countPages(); } finally { document.destroy(); }
    }));

    const parsed = await openPdfDocument(pdfPath);
    try {
      results.push(await measure('pdf_render_page_webp', pdfBytes.length, iterations, 'webp_bytes',
        async () => (await parsed.render(0, 1800)).byteLength));
    } finally { parsed.close(); }

    results.push(await measure('pdf_document_parse_and_cache', pdfBytes.length, iterations, 'pages', async () => {
      const document = await openPdfDocument(pdfPath);
      try { return document.pages.length; } finally { document.close(); }
    }));
    results.push(await measure('pdf_document_parse_and_render_page_webp', pdfBytes.length, iterations, 'webp_bytes', async () => {
      const document = await openPdfDocument(pdfPath);
      try { return (await document.render(0, 1800)).byteLength; } finally { document.close(); }
    }));

    const parser = new MarkdownIt({ html: true, linkify: true, typographer: true });
    results.push(await measure('markdown_parse', Buffer.byteLength(markdownSource), iterations, 'tokens',
      () => parser.parse(markdownSource, {}).length));
    results.push(await measure('markdown_parse_and_render_html', Buffer.byteLength(markdownSource), iterations, 'bytes',
      () => Buffer.byteLength(renderMarkdown(markdownSource))));

    results.push(await measure('typst_parse', Buffer.byteLength(typstSource), iterations, 'syntax_tree_nodes', async () => {
      const parsedSource = await analyzeTypst(typstSource);
      return parsedSource.headings.length + parsedSource.blocks.length;
    }));

    const engine = createTypstEngine({ root: typstRoot, profile: () => {} });
    const id = 'benchmark-typst';
    const compile = () => engine.compile({ id, file: typstPath, source: typstSource, theme: 'light' });
    const coldStart = performance.now();
    const cold = await compile();
    const coldElapsed = performance.now() - coldStart;
    results.push({ stage: 'typst_compile_cold', input_bytes: Buffer.byteLength(typstSource), iterations: 1,
      p50_ms: coldElapsed, p95_ms: coldElapsed,
      min_ms: coldElapsed, output_size: cold.info.length, output_unit: 'pages' });
    results.push(await measure('typst_compile_warm', Buffer.byteLength(typstSource), iterations, 'pages',
      async () => (await compile()).info.length));
    results.push(await measure('typst_render_page_svg_uncached', Buffer.byteLength(typstSource), iterations, 'svg_bytes',
      async () => Buffer.byteLength((await engine.page({ id, page: 1 })).svg)));
    engine.discard(id);

    const report = {
      schema_version: 1,
      implementation: 'js-legacy',
      node_version: process.version,
      revision: process.env.BENCHMARK_REVISION || null,
      os: process.platform, arch: process.arch, iterations,
      fixture_bytes: { markdown: Buffer.byteLength(markdownSource), typst: Buffer.byteLength(typstSource), pdf: pdfBytes.length, pdf_pages: 12 },
      rss_before_kib: rssBefore, rss_after_kib: memoryKb(),
      peak_rss_before_kib: peakBefore, peak_rss_after_kib: peakMemoryKb(),
      notes: {
        pdf_render: 'MuPDF rasterizes page 1 at width 1800 and encodes WebP; Rust Hayro benchmark exports vector SVG.',
        markdown_parse: 'MarkdownIt core tokenization only; the full-render stage uses the production renderer and plugins.',
        typst_parse: 'Production tree-sitter analysis plus heading/block extraction; Rust measures Typst syntax parsing only.',
        memory: 'Whole-process RSS/HWM after imports and benchmark work; compare only same-machine fresh-process runs.',
      },
      results,
    };
    const output = process.env.JS_BACKEND_PERF_OUTPUT || 'reports/benchmark-backend/js.json';
    const target = resolve(output);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

await main();
