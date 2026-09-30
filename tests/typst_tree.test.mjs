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
