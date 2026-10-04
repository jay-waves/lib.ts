import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTypstImage } from '../library/typst-image.mjs';

test('image links account for nested transforms and a page viewBox offset', () => {
  const { svg, links } = prepareTypstImage('<svg viewBox="0 400 200 100">'
    + '<g transform="translate(0,400)"><g transform="translate(20,10) scale(2)">'
    + '<foreignObject><div class="tsel">No selectable text</div></foreignObject>'
    + '<a data-typst-page="2" data-typst-x="10.5" data-typst-y="20"><rect class="pseudo-link" x="5" y="2" width="20" height="10"/></a>'
    + '</g><g transform="translate(100,50)"><a target="_blank" xlink:href="https://example.com/?a=1&amp;b=2">'
    + '<rect class="pseudo-link" width="10" height="5"/></a></g></g></svg>');
  assert.doesNotMatch(svg, /foreignObject|tsel|No selectable text/);
  assert.ok(Math.abs(links[0].top - 14) < 1e-10);
  assert.deepEqual(links.map(link => ({ ...link, top: Math.round(link.top) })), [
    { left: 15, top: 14, width: 20, height: 20, page: 2, x: 10.5, y: 20 },
    { left: 50, top: 50, width: 5, height: 5, href: 'https://example.com/?a=1&b=2', target: '_blank' },
  ]);
});

test('rotated and mirrored link rectangles produce valid overlay bounds', () => {
  const { links } = prepareTypstImage('<svg viewBox="0 0 100 100"><g transform="translate(50,20) rotate(90)">'
    + '<a href="https://example.com"><rect class="pseudo-link" width="10" height="20"/></a></g>'
    + '<g transform="matrix(-1 0 0 1 80 40)"><a href="mailto:test@example.com"><rect class="pseudo-link" width="10" height="5"/></a></g></svg>');
  assert.equal(links.length, 2);
  assert.ok(Math.abs(links[0].left - 30) < 1e-10);
  assert.equal(links[0].top, 20);
  assert.ok(Math.abs(links[0].width - 20) < 1e-10);
  assert.ok(Math.abs(links[0].height - 10) < 1e-10);
  assert.equal(links[1].left, 70);
});

test('only link rectangles become overlays, and executable destinations are excluded', () => {
  const { links } = prepareTypstImage('<svg viewBox="0 0 100 100"><rect width="100" height="100"/>'
    + '<a href="javascript&#58;alert(1)"><rect class="pseudo-link" width="20" height="10"/></a>'
    + '<a href="https://example.com"><rect class="pseudo-link" width="0" height="10"/></a>'
    + '<a href="https://example.com"><rect class="pseudo-link" width="20" height="10"/></a></svg>');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.com');
  assert.throws(() => prepareTypstImage('<svg/>'), /viewBox/);
});
