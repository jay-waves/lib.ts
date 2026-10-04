import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSearchPaths } from '../library/path-search.mjs';

test('list search matches paths, deduplicates current tabs and includes binary files', () => {
  const paths = ['docs/Guide.md', 'docs/Guide.md', 'images/cover.png', 'notes/other.md'];
  assert.deepEqual(filterSearchPaths(paths, 'guide').map(file => file.path), ['docs/Guide.md']);
  assert.deepEqual(filterSearchPaths(paths, 'cover').map(file => file.path), ['images/cover.png']);
  assert.equal(filterSearchPaths(paths, 'a phrase from file contents').length, 0);
  assert.equal(filterSearchPaths(paths, '').length, 3);
});
test('list search respects language, path, case and regex filters', () => {
  const paths = ['docs/Guide.md', 'src/Guide.ts', 'docs/guide.typ'];
  assert.deepEqual(filterSearchPaths(paths, 'guide lang:md path:docs/').map(file => file.path), ['docs/Guide.md']);
  assert.deepEqual(filterSearchPaths(paths, 'guide case:yes').map(file => file.path), ['docs/guide.typ']);
  assert.deepEqual(filterSearchPaths(paths, '/Guide\\.ts$/').map(file => file.path), ['src/Guide.ts']);
});
