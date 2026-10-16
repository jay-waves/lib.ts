import test from 'node:test';
import assert from 'node:assert/strict';
import { readerPosition, restoreReaderPosition, navigateReaderSymbol } from '../web/reader-position.mjs';

test('Reader captures and restores image and PDF positions on both axes', () => {
  let movement;
  const page = { getBoundingClientRect: () => ({ left: 20, top: 50, bottom: 650, width: 800, height: 600 }) };
  const panel = { clientWidth: 1000, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelectorAll: selector => { assert.equal(selector, '.document-page[data-page]'); return [page]; },
    scrollBy: value => { movement = value; } };
  for (const type of ['image', 'pdf']) {
    const position = readerPosition(panel, { type }, 'preview', 62);
    assert.deepEqual(position, { page: { index: 0, x: .6, y: 12 / 600 } });
    restoreReaderPosition(panel, { type }, 'preview', position, 62);
    assert.deepEqual(movement, { left: 0, top: 0, behavior: 'instant' });
  }
});

test('Reader maps raw source positions using the toolbar inset', () => {
  let movement;
  const lines = Array.from({ length: 10 }, (_, index) => ({
    getBoundingClientRect: () => ({ top: 100 + index * 20, bottom: 120 + index * 20, height: 20 }),
  }));
  const panel = { clientTop: 0, scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => lines, querySelector: selector => lines[Number(selector.slice(2)) - 1],
    scrollTo: value => { movement = value; } };
  const position = readerPosition(panel, { type: 'text' }, 'raw', 62);
  assert.deepEqual(position, { line: 4, view: 'raw' });
  restoreReaderPosition(panel, { type: 'text' }, 'raw', position, 62);
  assert.deepEqual(movement, { top: 0, behavior: 'instant' });
});

test('PDF outline navigation uses the shared viewport and clears the sticky toolbar', () => {
  let movement;
  const panel = { clientTop: 0, scrollTop: 100, getBoundingClientRect: () => ({ top: 50 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 500 }) }],
    scrollTo: value => { movement = value; } };
  assert.equal(navigateReaderSymbol(panel, { type: 'pdf' }, 'preview', { page: 1 }, 62), true);
  assert.deepEqual(movement, { top: 488, behavior: 'instant' });
});

test('PDF bookmarks navigate within a scaled page and groups do not move the reader', () => {
  let movement;
  const panel = { clientTop: 0, scrollTop: 100, getBoundingClientRect: () => ({ top: 50 }),
    querySelectorAll: () => [{ getBoundingClientRect: () => ({ top: 500, height: 1200 }) }],
    scrollTo: value => { movement = value; } };
  assert.equal(navigateReaderSymbol(panel, { type: 'pdf' }, 'preview', { page: 1, y: .25 }, 62), true);
  assert.deepEqual(movement, { top: 788, behavior: 'instant' });
  movement = null;
  assert.equal(navigateReaderSymbol(panel, { type: 'pdf' }, 'preview', { group: true }, 62), false);
  assert.equal(movement, null);
});

test('raw restoration uses the shared viewport even while preview styling is present', () => {
  let movement;
  const line = { getBoundingClientRect: () => ({ top: 500, height: 20 }) };
  const panel = { classList: { contains: () => true }, clientTop: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelector: selector => selector === '#L21' ? line : null,
    scrollTo: value => { movement = value; } };
  restoreReaderPosition(panel, { type: 'typst' }, 'raw', { line: 21 }, 62);
  assert.deepEqual(movement, { top: 338, behavior: 'instant' });
});

test('opening or switching at line one keeps the PathBar at the document top', () => {
  let movement;
  const panel = { scrollTo: value => { movement = value; } };
  for (const type of ['markdown', 'typst', 'text', 'pdf', 'image']) {
    for (const view of ['preview', 'raw']) {
      restoreReaderPosition(panel, { type }, view, { line: 1 }, 62);
      assert.deepEqual(movement, { top: 0, behavior: 'instant' });
    }
  }
});
