import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapsedSectionIds } from './heading-state.mjs';

test('legacy collapsed headings migrate to section IDs without extra DOM attributes', () => {
  const section = (id, text, level) => ({ id, dataset: { headingLevel: String(level) },
    querySelector: () => ({ textContent: text }) });
  const root = { querySelectorAll: () => [
    section('section-实验结果', '实验结果', 2),
    section('section-实验结果-1', '实验结果', 2),
    section('section-a--b', 'A--B', 1),
  ] };
  assert.deepEqual([...collapsedSectionIds(root, ['H2:实验结果:1', 'H1:a--b:0'])],
    ['section-实验结果-1', 'section-a--b']);
  assert.deepEqual([...collapsedSectionIds(root, ['section-实验结果'])], ['section-实验结果']);
});
