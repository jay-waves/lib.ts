import test from 'node:test';
import assert from 'node:assert/strict';
import { activeSymbolId, symbolSelectionAt, revealSymbolVertically } from '../web/active-symbol.mjs';

const symbols = [
  { id: 'intro', line: 3 },
  { id: 'usage', line: 12 },
  { id: 'details', line: 30 },
];

test('active symbol follows the closest preceding source heading', () => {
  assert.equal(activeSymbolId(symbols, { line: 1 }), 'intro');
  assert.equal(activeSymbolId(symbols, { line: 12 }), 'usage');
  assert.equal(activeSymbolId(symbols, { line: 29 }), 'usage');
  assert.equal(activeSymbolId(symbols, { line: 999 }), 'details');
});

test('PDF symbols follow pages and missing positions select nothing', () => {
  const outline = [{ id: 'one', page: 1 }, { id: 'three', page: 3 }];
  assert.equal(activeSymbolId(outline, { page: 2 }), 'one');
  assert.equal(activeSymbolId(outline, { page: 3 }), 'three');
  assert.equal(activeSymbolId(outline, {}), null);
  assert.equal(activeSymbolId([], { line: 4 }), null);
});

test('symbol reveal scrolls only the vertical axis and only when needed', () => {
  const container = { scrollTop: 100, scrollLeft: 37,
    getBoundingClientRect: () => ({ top: 20, bottom: 220 }) };
  revealSymbolVertically(container, { getBoundingClientRect: () => ({ top: 180, bottom: 250 }) });
  assert.equal(container.scrollTop, 130);
  assert.equal(container.scrollLeft, 37);
  revealSymbolVertically(container, { getBoundingClientRect: () => ({ top: 5, bottom: 35 }) });
  assert.equal(container.scrollTop, 115);
  assert.equal(container.scrollLeft, 37);
  revealSymbolVertically(container, { getBoundingClientRect: () => ({ top: 30, bottom: 80 }) });
  assert.equal(container.scrollTop, 115);
});


test('outline selection wins over the preceding heading until the viewport moves', () => {
  let selection = { id: 'usage', top: 100 };
  selection = symbolSelectionAt(selection, 100);
  assert.equal(activeSymbolId(symbols, { line: 3, symbolId: selection?.id }), 'usage');
  selection = symbolSelectionAt(selection, 101);
  assert.equal(activeSymbolId(symbols, { line: 3, symbolId: selection?.id }), 'intro');
  // Returning to the old offset must not revive the click selection.
  assert.equal(symbolSelectionAt(selection, 100), null);
});

test('same-page PDF clicks select the requested entry and stale IDs fall back to sync', () => {
  const outline = [{ id: 'one', page: 1 }, { id: 'two', page: 1 }];
  for (const symbol of outline) {
    const selection = symbolSelectionAt({ id: symbol.id, top: 0 }, 0);
    assert.equal(activeSymbolId(outline, { page: 1, symbolId: selection.id }), symbol.id);
  }
  assert.equal(activeSymbolId(outline, { page: 1, symbolId: 'removed' }), 'two');
});
