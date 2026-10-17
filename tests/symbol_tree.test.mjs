import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolTree, symbolBranch } from '../web/symbol-tree.ts';

test('symbol hierarchy handles skipped levels and siblings without modifying symbols', () => {
  const symbols = [
    { id: 'root', name: 'Root', level: 1 },
    { id: 'deep', name: 'Deep', level: 3 },
    { id: 'nested', name: 'Nested', level: 4 },
    { id: 'sibling', name: 'Sibling', level: 2 },
    { id: 'next', name: 'Next', level: 1 },
    { id: 'plain', name: 'Plain' },
  ];
  const original = structuredClone(symbols);
  const tree = buildSymbolTree(symbols);
  assert.deepEqual(tree.map(node => node.symbol.id), ['root', 'next', 'plain']);
  assert.deepEqual(tree[0].children.map(node => node.symbol.id), ['deep', 'sibling']);
  assert.deepEqual(symbolBranch(tree, 'nested'), ['root', 'deep', 'nested']);
  assert.deepEqual(symbolBranch(tree, 'deep'), ['root', 'deep', 'nested']);
  assert.deepEqual(symbolBranch(tree, 'sibling'), ['root', 'sibling']);
  assert.deepEqual(symbolBranch(tree, 'root'), ['root', 'deep', 'nested', 'sibling']);
  assert.deepEqual(symbolBranch(tree, 'missing'), []);
  assert.deepEqual(symbols, original);
  assert.deepEqual(buildSymbolTree([]), []);
});
