import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDocumentViewport, isSvgDocument } from '../web/preview-kind.mjs';

test('SVG content uses the document viewport regardless of filename', () => {
  const svg = { type: 'image', mime: 'image/svg+xml', name: 'drawing.txt' };
  assert.equal(isSvgDocument(svg), true);
  for (const document of [svg, { type: 'pdf' }, { type: 'typst' },
    ...['image/png', 'image/jpeg', 'image/webp', 'image/gif'].map(mime => ({ type: 'image', mime }))])
    assert.equal(hasDocumentViewport(document), true);
  for (const document of [null, { type: 'markdown' }, { type: 'binary' }])
    assert.equal(hasDocumentViewport(document), false);
});
