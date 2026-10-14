import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../server/markdown/renderer.mjs';
import { parseFragment } from 'parse5';

function outlineHeadings(html) {
  const headings = [];
  function visit(node) {
    if (/^h[1-6]$/.test(node.tagName || '')) {
      const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      if (attrs.id && attrs['data-source-line'] !== undefined) headings.push({
        id: attrs.id, level: Number(node.tagName.slice(1)), line: Number(attrs['data-source-line']),
      });
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parseFragment(html));
  return headings;
}

test('outline retains Unicode headings, duplicates and all heading levels', () => {
  const html = renderMarkdown('# 简介\n\n## 安装说明\n\n### 简介\n\n#### 日本語\n\n##### 한국어\n\n###### Café\n\n# Hello World');
  assert.deepEqual(outlineHeadings(html), [
    { id: '简介', level: 1, line: 0 },
    { id: '安装说明', level: 2, line: 2 },
    { id: '简介-1', level: 3, line: 4 },
    { id: '日本語', level: 4, line: 6 },
    { id: '한국어', level: 5, line: 8 },
    { id: 'café', level: 6, line: 10 },
    { id: 'hello-world', level: 1, line: 12 },
  ]);
});

test('outline gives empty slugs unique anchors without losing nested or setext headings', () => {
  const html = renderMarkdown('# !!!\n\n# 😀\n\n# $x^2$\n\n# heading\n\n> ## 引用标题\n\n- ### 列表标题\n\n下划线标题\n==========\n\n```md\n# Not a heading\n```');
  assert.deepEqual(outlineHeadings(html), [
    { id: 'heading', level: 1, line: 0 },
    { id: 'heading-1', level: 1, line: 2 },
    { id: 'heading-2', level: 1, line: 4 },
    { id: 'heading-3', level: 1, line: 6 },
    { id: '引用标题', level: 2, line: 8 },
    { id: '列表标题', level: 3, line: 10 },
    { id: '下划线标题', level: 1, line: 12 },
  ]);
});

test('zero-width spaces are removed only from formulas without KaTeX warnings', t => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const dirty = 'Inline $x\u200b^2$ and $\\text{a\u200bb}$.\n\n$$\nx\u200b + y\n$$\n\n\\begin{aligned}a\u200b &= b\\end{aligned}';
  assert.equal(renderMarkdown(dirty), renderMarkdown(dirty.replace(/\u200b/g, '')));
  assert.equal(warnings.mock.callCount(), 0);
  const prose = renderMarkdown('Prose a\u200bb.\n\n`a\u200bb`\n\n```text\na\u200bb\n```');
  assert.equal(prose.split('\u200b').length - 1, 3);
});

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
  assert.match(html, /<pre data-source-line="8"><code class="language-js">/);
  assert.match(html, /<code class="language-js"><span class="hljs-keyword">const<\/span>/);
  assert.match(html, /class="code-lang">js<\/span>/);
  assert.match(renderMarkdown('    indented'), /<pre data-source-line="0"><code>indented/);
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

test('heading sections preserve document hierarchy and inline footnotes', () => {
  const html = renderMarkdown('# Parent\n\nText[^1]\n\n## Child\n\nMore\n\n# Next\n\n[^1]: Note');
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H1:parent:0"/);
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H2:child:0"/);
  assert.match(html, /<aside id="fn1" class="inline-footnote" role="doc-footnote" hidden>/);
  assert.equal((html.match(/<section class="heading-section/g) || []).length, 3);
  assert.equal((html.match(/<\/section>/g) || []).length, 3);
  assert.match(html, /<\/section>\s*<\/section>\s*<section class="heading-section"[^>]*data-heading-key="H1:next:0"/);
});

test('heading DOM anchors survive edits before a section', () => {
  const anchor = html => html.match(/id="(heading-section-[^"]+)"/g);
  assert.deepEqual(anchor(renderMarkdown('# First\n\nText\n\n## Child\n\nMore')),
    anchor(renderMarkdown('New introduction\n\n# First\n\nChanged text\n\n## Child\n\nMore')));
});

test('inline footnotes show the matching reference number once, in reference order', () => {
  const html = renderMarkdown('First[^b], second[^a], repeated[^b].\n\n[^a]: Alpha **bold**\n[^b]: Beta');
  assert.match(html, /<aside id="fn1" class="inline-footnote" role="doc-footnote" hidden>\s*<p[^>]*><a[^>]*class="footnote-label"[^>]*>\[1\]<\/a> Beta/);
  assert.match(html, /<aside id="fn2" class="inline-footnote" role="doc-footnote" hidden>\s*<p[^>]*><a[^>]*class="footnote-label"[^>]*>\[2\]<\/a> Alpha <strong>bold<\/strong>/);
  assert.equal((html.match(/class="footnote-label"/g) || []).length, 2);
});

test('inline footnotes containing only a code block still have a number', () => {
  const html = renderMarkdown('Text[^code]\n\n[^code]:\n    ```js\n    const x = 1;\n    ```');
  assert.match(html, /<aside id="fn1" class="inline-footnote" role="doc-footnote" hidden>\s*<p><a[^>]*class="footnote-label"[^>]*>\[1\]<\/a><\/p>\s*<div class="code-wrap">/);
  assert.match(html, /<code class="language-js">/);
});

test('raw HTML headings stay ordinary content inside Markdown sections', () => {
  const html = renderMarkdown('# Markdown\n\n<h2 id="raw">Raw</h2>\n\nText');
  assert.match(html, /<section class="heading-section has-heading-content"[^>]*data-heading-key="H1:markdown:0"/);
  assert.match(html, /<div class="heading-content">\s*<h2 id="raw">Raw<\/h2>/);
  assert.equal((html.match(/<section class="heading-section/g) || []).length, 1);
});

test('footnotes share a paragraph panel but repeat independently in other paragraphs', () => {
  const html = renderMarkdown('One[^n] and again[^n].\n\nTwo[^n].\n\n[^n]: **Rich** note $x^2$.');
  const tree = parseFragment(html);
  const elements = tree.childNodes.filter(node => node.tagName);
  assert.deepEqual(elements.map(node => node.tagName), ['p', 'aside', 'p', 'aside']);
  const attr = (node, key) => node.attrs.find(attr => attr.name === key)?.value;
  const notes = elements.filter(node => node.tagName === 'aside');
  assert.deepEqual(notes.map(node => attr(node, 'id')), ['fn1', 'fn1-2']);
  assert.ok(notes.every(node => attr(node, 'hidden') === ''));
  assert.equal((html.match(/data-footnote-ref="fn1"/g) || []).length, 2);
  assert.equal((html.match(/data-footnote-ref="fn1-2"/g) || []).length, 1);
  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  for (const note of html.matchAll(/<aside\b[\s\S]*?<\/aside>/g)) {
    assert.doesNotMatch(note[0], /data-source-line/);
    assert.match(note[0], /<strong>Rich<\/strong>/);
    assert.equal((note[0].match(/class="footnote-label"/g) || []).length, 1);
    assert.doesNotMatch(note[0], /footnote-backref|↩/);
  }
});

test('footnote panels stay inside list items and quotes, and outside tables', () => {
  const html = renderMarkdown('- Item[^n]\n- Next\n\n> Quote[^n]\n\n| Column |\n|---|\n| Cell[^n] |\n\n[^n]: Note');
  assert.match(html, /<aside[^>]*id="fn1"[\s\S]*?<\/aside>\s*<\/li>/);
  assert.match(html, /<blockquote[^>]*>\s*<p[^>]*>[\s\S]*?<\/p>\s*<aside[^>]*id="fn1-1"/);
  assert.match(html, /<\/table>\s*<aside[^>]*id="fn1-2"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('long footnotes use only the first-paragraph label to return, without a trailing icon', () => {
  const source = `Reference[^n]\n\n[^n]: ${'Long footnote text '.repeat(100)}\n\n    Final **paragraph**.`;
  const tree = parseFragment(renderMarkdown(source));
  const note = tree.childNodes.find(node => node.tagName === 'aside');
  const children = note.childNodes.filter(node => node.tagName);
  assert.deepEqual(children.map(node => node.tagName), ['p', 'p']);
  assert.equal(children[0].childNodes[0].childNodes[0].value, '[1]');
  assert.match(children[0].childNodes[1].value, /^ Long footnote text/);
  const label = children[0].childNodes[0];
  assert.equal(label.tagName, 'a');
  assert.equal(label.attrs.find(attr => attr.name === 'href').value, '#fnref1');
  assert.equal(children.at(-1).childNodes.at(-1).value, '.');
});
