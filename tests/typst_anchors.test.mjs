import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { anchorSource, anchorTable, positionForLine, lineForPosition } from '../typst-anchors.mjs';

test('anchors preserve lines and skip blank lines inside code and raw fences', () => {
  const source = '#let value = {\n\n  1\n}\n\n#rect(width: 1pt)\n\n```typ\n\n```\n\n#rect(width: 2pt)';
  const marked = anchorSource(source);
  assert.equal(marked.text.split('\n').length, source.split('\n').length);
  assert.deepEqual([...marked.positions.values()], [5, 7, 11]);
  assert.match(marked.text.split('\n')[1], /^$/);
  assert.match(marked.text.split('\n')[8], /^$/);
});

test('queried page positions interpolate in both directions', () => {
  const sizes = [{ height: 100 }, { height: 100 }];
  const positions = new Map([['a', 2], ['b', 12]]);
  const values = [
    { value: { id: 'a', pos: { page: 1, y: '50pt' } } },
    { value: { id: 'b', pos: { page: 2, y: '50pt' } } },
  ];
  const table = anchorTable(values, positions, sizes);
  assert.deepEqual(positionForLine(7, table, sizes), { page: 1, y: 1 });
  assert.equal(lineForPosition(2, 0, table, sizes), 7);
  assert.equal(lineForPosition(3, 0, table, sizes), undefined);
});
