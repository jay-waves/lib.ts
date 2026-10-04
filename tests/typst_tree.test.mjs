import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyzeTypst, anchorBlocks } from '../typst-tree.mjs';

test('Typst grammar identifies headings and large markup blocks', async () => {
  const source = '= Alpha\n\nParagraph\n\n#let x = {\n\n  1\n}\n\n$ a + b $\n\n#table(columns: 2, [A], [B])\n\n== Beta\n\nSecond';
  const parsed = await analyzeTypst(source);
  assert.deepEqual(parsed.headings, [
    { level: 1, name: 'Alpha', line: 1 },
    { level: 2, name: 'Beta', line: 14 },
  ]);
  assert.deepEqual(parsed.blocks.map(({ kind, line }) => ({ kind, line })), [
    { kind: 'paragraph', line: 3 }, { kind: 'code', line: 5 },
    { kind: 'equation', line: 10 }, { kind: 'table', line: 12 },
    { kind: 'heading', line: 14 }, { kind: 'paragraph', line: 16 },
  ]);
  const marked = anchorBlocks(source, parsed.blocks);
  assert.equal(marked.text.split('\n').length, source.split('\n').length);
  assert.equal(marked.text.split('\n')[5], '', 'blank line inside code remains untouched');
  assert.deepEqual([...marked.positions.values()], [3, 5, 10, 12, 14, 16]);
});

test('sparse library anchors keep all heading positions and preserve source lines and labels', async () => {
  const source = '= First <first>\n' + Array.from({ length: 20 }, (_, index) => `\nParagraph ${index}\n`).join('')
    + '\n== Last <last>\n\nEnd';
  const parsed = await analyzeTypst(source);
  const dense = anchorBlocks(source, parsed.blocks);
  const sparse = anchorBlocks(source, parsed.blocks, { headings: parsed.headings, minLineGap: 24 });
  assert.equal(sparse.text.split('\n').length, source.split('\n').length);
  assert.ok(sparse.positions.size < dense.positions.size / 2);
  for (const heading of parsed.headings) {
    assert.equal(sparse.positions.get(`preview-heading-${heading.line}`), heading.line);
    assert.match(sparse.text.split('\n')[heading.line - 1], /#context metadata.*<[\w-]+>$/);
  }
  assert.ok([...sparse.positions.values()].includes(parsed.blocks.at(-1).line));
});
