import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTypst, anchorBlocks } from '../typst-tree.mjs';
import { compileTypstVector } from '../typst-compile.mjs';
import { createTypstRuntime } from '../typst-runtime.mjs';
import { pageInfoFromArtifact } from '../typst-pages.mjs';
import { anchorTable, positionForLine, lineForPosition } from '../typst-anchors.mjs';
import { sourceLineAtViewport, scrollToTypstSource } from '../library/typst-navigation.mjs';

test('heading nodes compile on their real pages without changing layout or label targets', async () => {
  const source = '#set text(font: "Arial")\n#set heading(numbering: "1.")\n#set page(width: 300pt, height: 300pt)\n'
    + '= First <first>\n\nSee @second.\n#pagebreak()\n= Second <second>\n\nLast paragraph';
  const parsed = await analyzeTypst(source);
  const marked = anchorBlocks(source, parsed.blocks, { headings: parsed.headings, minLineGap: 24 });
  const runtime = createTypstRuntime({ emit() {}, memorySample() {}, unvirtual: path => path });
  const { compiler, renderer } = await runtime.init();
  await runtime.initFonts();
  const original = await compileTypstVector(compiler, '/navigation.typ', source);
  assert.ok(original.artifact, JSON.stringify(original.diagnostics));
  const baselinePages = await pageInfoFromArtifact(renderer, original.artifact);
  const result = await compileTypstVector(compiler, '/navigation.typ', marked.text, { queryAnchors: true });
  assert.ok(result.artifact, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.some(item => item.severity === 'error'), false);
  const pages = await pageInfoFromArtifact(renderer, result.artifact);
  assert.deepEqual(pages.map(({ width, height }) => ({ width, height })),
    baselinePages.map(({ width, height }) => ({ width, height })));
  const anchors = anchorTable(result.anchors, marked.positions, pages);
  for (const [index, heading] of parsed.headings.entries()) {
    const anchor = anchors.find(item => item.line === heading.line);
    assert.ok(anchor, `Missing anchor for ${heading.name}`);
    assert.equal(anchor.page, index + 1);
    assert.ok(anchor.y > 0 && anchor.y < pages[index].height);
    const position = positionForLine(heading.line, anchors, pages);
    assert.equal(lineForPosition(position.page, position.y, anchors, pages), heading.line);
  }
});

test('view switching maps panel positions with zoom and toolbar inset in both directions', () => {
  const document = { anchors: [{ line: 1, page: 1, y: 10, absoluteY: 10 },
    { line: 21, page: 2, y: 10, absoluteY: 110 }], pages: [{ height: 100 }, { height: 100 }] };
  const raw = Array.from({ length: 21 }, (_, index) => ({ getBoundingClientRect: () => ({ top: 150 + index * 20, bottom: 170 + index * 20, height: 20 }) }));
  const pages = [200, 420].map(top => ({ getBoundingClientRect: () => ({ top, bottom: top + 200, height: 200 }) }));
  let scrolled;
  const panel = { clientTop: 2, scrollTop: 100, getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: selector => selector === 'div.typst-page[data-page]' ? pages : raw,
    querySelector: selector => raw[Number(selector.slice(2)) - 1], scrollTo: value => { scrolled = value; } };
  assert.equal(sourceLineAtViewport(panel, document, 'raw', 250), 11);
  const line = sourceLineAtViewport(panel, document, 'preview', 198);
  assert.equal(line, 9);
  scrollToTypstSource(panel, document, 'raw', line, 48);
  assert.equal(scrolled.top, 260);
  scrollToTypstSource(panel, document, 'preview', 11, 48);
  assert.equal(scrolled.top, 270);
  // Outline navigation uses the compiler position directly, independently of interpolation.
  scrollToTypstSource(panel, document, 'preview', 11, 48, { position: { page: 2, y: .5 } });
  assert.equal(scrolled.top, 470);
});

test('Markdown current line converts zero-based source markers and interpolates visible blocks', () => {
  const blocks = [{ line: 0, top: 150 }, { line: 10, top: 350 }, { line: 20, top: 550 }];
  const panel = { clientTop: 0, getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => blocks.map(item => ({ dataset: { sourceLine: String(item.line) },
      getBoundingClientRect: () => ({ top: item.top, height: 100 }) })) };
  const document = { type: 'markdown', lineCount: 25 };
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 0), 1);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 150), 6);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 250), 11);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 1000), 25);
});

test('Typst source navigation scrolls the document viewport without moving its shell', () => {
  let scroll;
  const page = { getBoundingClientRect: () => ({ top: 200, bottom: 400, height: 200 }) };
  const viewport = { clientTop: 0, scrollTop: 100,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [page], scrollTo: value => { scroll = value; } };
  const shell = { querySelector: () => viewport, scrollTo: () => assert.fail('shell must stay fixed') };
  const document = { type: 'typst', pages: [{ height: 100 }] };
  scrollToTypstSource(shell, document, 'preview', 1, 80, { position: { page: 1, y: .5 } });
  assert.equal(scroll.top, 288);
  scrollToTypstSource(shell, document, 'preview', 1, 80,
    { position: { page: 1, y: .5 }, navigation: 'outline' });
  assert.equal(scroll.top, 272);
  viewport.closest = () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 140 }) }) });
  scrollToTypstSource(shell, document, 'preview', 1, 80,
    { position: { page: 1, y: .5 }, navigation: 'outline' });
  assert.equal(scroll.top, 232);
});
