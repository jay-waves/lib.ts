import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockForLine, fragmentTarget } from './block-navigation.mjs';

const blocks = [5, 35, 46].map(line => ({ dataset: { line: String(line) } }));
const heading = { id: '实验结果' };
const root = { querySelectorAll: selector => selector === '[data-line]' ? blocks : [heading] };
test('line fragments snap to blocks, including gaps and document boundaries', () => {
  for (const [line, index] of [[1, 0], [35, 1], [42, 1], [46, 2], [999, 2]]) {
    assert.equal(blockForLine(root, line), blocks[index]);
    assert.equal(fragmentTarget(root, `#L${line}`), blocks[index]);
  }
  assert.equal(blockForLine(root, 0), null);
  assert.equal(fragmentTarget(root, '#%ZZ'), null);
  assert.equal(fragmentTarget(root, '#%E5%AE%9E%E9%AA%8C%E7%BB%93%E6%9E%9C'), heading);
});
