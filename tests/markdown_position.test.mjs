import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMarkdownPosition } from '../library/markdown-position.mjs';
import { sourceLineAtViewport, scrollToTypstSource } from '../library/typst-navigation.mjs';

test('Markdown caches geometry across scrolling and navigation, then refreshes changed layout', () => {
  let scans = 0, reads = 0, resizeCallback, mutationCallback, records = [];
  const listeners = new Map();
  const events = { addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name) };
  let disconnected = 0;
  class ResizeObserver {
    constructor(callback) { resizeCallback = callback; }
    observe() {}
    unobserve() {}
    disconnect() { disconnected++; }
  }
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    takeRecords() { const result = records; records = []; return result; }
    disconnect() { disconnected++; }
  }
  const win = { ...events, ResizeObserver, MutationObserver };
  const root = { ...events, ownerDocument: { defaultView: win } };
  const document = { type: 'markdown', lineCount: 25 };
  const coordinates = [50, 250, 450];
  const panel = { clientTop: 2, scrollTop: 0,
    getBoundingClientRect: () => { reads++; return { top: 100 }; },
    querySelectorAll: () => { scans++; return blocks; },
    scrollTo: ({ top }) => { panel.scrollTop = top; } };
  const blocks = coordinates.map((_, index) => ({ dataset: { sourceLine: String(index * 10) },
    getBoundingClientRect: () => { reads++; return { top: 102 + coordinates[index] - panel.scrollTop, height: 100 }; } }));
  const dispose = observeMarkdownPosition(panel, root);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 0), 1);
  assert.equal(scans, 1);
  const initialReads = reads;
  panel.scrollTop = 100;
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 50), 6);
  panel.scrollTop = 250;
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 0), 11);
  scrollToTypstSource(panel, document, 'preview', 6, 50);
  assert.equal(panel.scrollTop, 100);
  assert.equal(scans, 1);
  assert.equal(reads, initialReads, 'cached queries must not measure any DOM rectangles');
  coordinates[1] = 350;
  resizeCallback();
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 100), 6);
  assert.equal(scans, 2);
  mutationCallback();
  sourceLineAtViewport(panel, document, 'preview', 0);
  assert.equal(scans, 3);
  records = [{}];
  sourceLineAtViewport(panel, document, 'preview', 0);
  assert.equal(scans, 4, 'same-task DOM mutations must invalidate before observer delivery');
  listeners.get('load')();
  sourceLineAtViewport(panel, document, 'preview', 0);
  assert.equal(scans, 5);
  dispose();
  assert.equal(disconnected, 2);
  assert.equal(listeners.size, 0);
  sourceLineAtViewport(panel, document, 'preview', 0);
  assert.equal(scans, 6, 'disposed caches must not survive remount');
});

test('hidden blocks are excluded and final source lines interpolate within the last block', () => {
  const panel = { clientTop: 0, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [
      { dataset: { sourceLine: '0' }, getBoundingClientRect: () => ({ top: 0, height: 100 }) },
      { dataset: { sourceLine: '10' }, getBoundingClientRect: () => ({ top: 50, height: 0 }) },
      { dataset: { sourceLine: '20' }, getBoundingClientRect: () => ({ top: 200, height: 100 }) },
    ], scrollTo: ({ top }) => { panel.scrollTop = top; } };
  const document = { type: 'markdown', lineCount: 25 };
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 100), 11);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 250), 23);
  scrollToTypstSource(panel, document, 'preview', 23, 0);
  assert.equal(panel.scrollTop, 250);
  assert.equal(sourceLineAtViewport(panel, document, 'preview', 1000), 25);
});
