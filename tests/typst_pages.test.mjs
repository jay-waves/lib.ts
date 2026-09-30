import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInlineSvg } from '../typst-pages.mjs';

test('SVG IDs and local references are namespaced without cascading replacements', () => {
  const svg = '<svg><path id="a"/><path id="p-a"/><use href="#a"/>'
    + '<use xlink:href="#p-a"/><g fill="url(#a)"/>'
    + '<use href="#external"/><use href="other.svg#a"/></svg>';
  assert.equal(prepareInlineSvg(svg, 'p'),
    '<svg><path id="p-a"/><path id="p-p-a"/><use href="#p-a"/>'
    + '<use xlink:href="#p-p-a"/><g fill="url(#p-a)"/>'
    + '<use href="#external"/><use href="other.svg#a"/></svg>');
});

test('Typst navigation and transparent link targets are preserved', () => {
  const result = prepareInlineSvg('<a onclick="handleTypstLocation(this, 2, 10.5, 20); return false">'
    + '<rect class="pseudo-link"/></a>', 'p');
  assert.match(result, /data-typst-page="2" data-typst-x="10.5" data-typst-y="20"/);
  assert.match(result, /<rect fill="transparent" class="pseudo-link"/);
});
