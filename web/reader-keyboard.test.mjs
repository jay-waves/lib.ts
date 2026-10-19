import assert from 'node:assert/strict';
import test from 'node:test';
import { pageReaderOnSpace } from './reader-keyboard.mjs';

function fixture(patch = {}) {
  const scrolls = [];
  const panel = { clientHeight: 600, scrollBy: options => scrolls.push(options) };
  const event = { code: 'Space', defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, ...patch };
  return { event, panel, scrolls };
}

test('reader pages documents and raw source while leaving media input alone', () => {
  for (const [type, view, shouldPage] of [
    ['pdf', 'preview', true], ['markdown', 'preview', true], ['image', 'preview', true],
    ['text', 'raw', true], ['binary', 'preview', false], ['text', 'preview', false],
  ]) {
    const { event, panel, scrolls } = fixture();
    pageReaderOnSpace(event, panel, type, view);
    assert.equal(event.defaultPrevented, shouldPage);
    assert.deepEqual(scrolls, shouldPage ? [{ top: 540, behavior: 'smooth' }] : []);
  }
});

test('reader yields to handled events, shortcuts, editable fields and controls', () => {
  for (const patch of [
    { defaultPrevented: true }, { code: 'Enter' }, { repeat: true },
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { target: { isContentEditable: true } }, { target: { closest: () => ({}) } },
  ]) {
    const { event, panel, scrolls } = fixture(patch);
    pageReaderOnSpace(event, panel, 'pdf', 'preview');
    assert.deepEqual(scrolls, []);
  }
});
