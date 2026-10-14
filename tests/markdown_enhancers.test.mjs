import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRawHighlighter } from '../web/raw-highlight-loader.mjs';
import { loadKatex, renderMath } from '../web/katex-loader.mjs';

test('raw views, search and Markdown share one lazily loaded highlighter module', async () => {
  const first = loadRawHighlighter();
  assert.equal(loadRawHighlighter(), first);
  const highlighter = await first;
  assert.equal((await loadRawHighlighter()).hljs, highlighter.hljs);
  assert.match(highlighter.highlightRaw('const answer = 42;', 'note.js'), /hljs-keyword/);
});
test('Markdown math shares one lazily loaded KaTeX module', async () => {
  const first = loadKatex();
  assert.equal(loadKatex(), first);
  const html = await renderMath('x^2', false);
  assert.match(html, /class="katex"/);
  assert.match(await renderMath('x^2', true), /katex-display/);
});
