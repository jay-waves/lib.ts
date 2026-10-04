import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../markdown-renderer.mjs';

test('Node-side Markdown renderer emits rich HTML and source positions', () => {
  const markdown = `---
title: Demo
---

# Heading

Inline $x^2$.

\`\`\`js
const answer = 42;
\`\`\`
`;
  const html = renderMarkdown(markdown);
  assert.match(html, /data-source-line="0"/);
  assert.match(html, /<h1[^>]*data-source-line="4"[^>]*>Heading<\/h1>/);
  assert.match(html, /class="katex"/);
  assert.match(html, /<code class="language-js"><span class="hljs-keyword">const<\/span>/);
  assert.match(html, /class="code-lang">js<\/span>/);
});

test('unknown fenced languages stay escaped and retain their label', () => {
  const html = renderMarkdown('```unknown title=demo\n<x>\n```');
  assert.match(html, /<code class="language-unknown">&lt;x&gt;/);
  assert.match(html, /class="code-lang">unknown<\/span>/);
});

test('raw HTML can be disabled before content reaches the browser', () => {
  const source = '<script>alert(1)</script>\n\nText';
  assert.match(renderMarkdown(source, { allowRawHtml: true }), /<script>/);
  assert.doesNotMatch(renderMarkdown(source, { allowRawHtml: false }), /<script>/);
});

test('heading sections preserve document hierarchy and sidenotes', () => {
  const html = renderMarkdown('# Parent\n\nText[^1]\n\n## Child\n\nMore\n\n# Next\n\n[^1]: Note');
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H1:parent:0"/);
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H2:child:0"/);
  assert.match(html, /<aside id="fn1" role="doc-footnote">/);
  assert.equal((html.match(/<section class="heading-section/g) || []).length, 3);
  assert.equal((html.match(/<\/section>/g) || []).length, 3);
  assert.match(html, /<\/section>\s*<\/section>\s*<section class="heading-section"[^>]*data-heading-key="H1:next:0"/);
});

test('heading DOM anchors survive edits before a section', () => {
  const anchor = html => html.match(/id="(heading-section-[^"]+)"/g);
  assert.deepEqual(anchor(renderMarkdown('# First\n\nText\n\n## Child\n\nMore')),
    anchor(renderMarkdown('New introduction\n\n# First\n\nChanged text\n\n## Child\n\nMore')));
});

test('sidenotes show the matching reference number once, in reference order', () => {
  const html = renderMarkdown('First[^b], second[^a], repeated[^b].\n\n[^a]: Alpha **bold**\n[^b]: Beta');
  assert.match(html, /<aside id="fn1" role="doc-footnote">\s*<p[^>]*><span class="sidenote-label">\[1\]<\/span> Beta/);
  assert.match(html, /<aside id="fn2" role="doc-footnote">\s*<p[^>]*><span class="sidenote-label">\[2\]<\/span> Alpha <strong>bold<\/strong>/);
  assert.equal((html.match(/class="sidenote-label"/g) || []).length, 2);
});

test('sidenotes containing only a code block still have a number', () => {
  const html = renderMarkdown('Text[^code]\n\n[^code]:\n    ```js\n    const x = 1;\n    ```');
  assert.match(html, /<aside id="fn1" role="doc-footnote">\s*<p><span class="sidenote-label">\[1\]<\/span> <\/p>/);
  assert.match(html, /<code class="language-js">/);
});

test('raw HTML headings stay ordinary content inside Markdown sections', () => {
  const html = renderMarkdown('# Markdown\n\n<h2 id="raw">Raw</h2>\n\nText');
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H1:markdown:0"/);
  assert.match(html, /<div class="heading-content">\s*<h2 id="raw">Raw<\/h2>/);
  assert.equal((html.match(/<section class="heading-section/g) || []).length, 1);
});
