import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateMarkdownFragment } from '../web/markdown/fragment-navigation.mjs';

const current = new URL('http://lib.localhost:49191/til/tree/vision/image-processing/photography.md');

test('footnote and backref links scroll the active preview below its toolbar', () => {
  for (const id of ['fn-3', 'fnref-3', 'fnref-3-2', '注释:3']) {
    let movement, address, expanded = 0;
    const section = { classList: { remove: name => { assert.equal(name, 'is-collapsed'); expanded++; } } };
    const details = { open: false };
    const target = { id, closest: () => section, parentElement: { closest: () => details },
      getBoundingClientRect: () => ({ top: 500 }) };
    const panel = { scrollTop: 100, clientTop: 2, getBoundingClientRect: () => ({ top: 50 }),
      querySelector: () => ({ getBoundingClientRect: () => ({ height: 48 }) }),
      scrollTo: value => { movement = value; } };
    const state = { reader: 'keep' };
    const root = { querySelectorAll: () => [target], closest: () => panel,
      ownerDocument: { defaultView: { history: { state, replaceState: (value, title, url) => {
        assert.strictEqual(value, state); address = url;
      } } } } };
    const link = new URL(`#${encodeURIComponent(id)}`, current);
    assert.equal(navigateMarkdownFragment(root, link, current), true);
    assert.deepEqual(movement, { top: 488, behavior: 'instant' });
    assert.equal(address, link.href);
    assert.equal(expanded, 1);
    assert.equal(details.open, true);
  }
});

test('missing or malformed local fragments do not become document navigation', () => {
  const root = { querySelectorAll: () => [] };
  assert.equal(navigateMarkdownFragment(root, new URL('#missing', current), current), true);
  assert.equal(navigateMarkdownFragment(root, new URL('#%ZZ', current), current), true);
});

test('other documents, queries and origins retain their normal navigation', () => {
  const root = { querySelectorAll: () => { throw new Error('Must not inspect this preview'); } };
  for (const href of ['other.md#fn-3', '?view=raw#fn-3', 'https://example.com/#fn-3', current.href]) {
    assert.equal(navigateMarkdownFragment(root, new URL(href, current), current), false);
  }
});
