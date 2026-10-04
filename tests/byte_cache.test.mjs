import test from 'node:test';
import assert from 'node:assert/strict';
import { createByteCache, svgImageBytes } from '../library/byte-cache.mjs';

test('byte budget evicts LRU values and oversized replacements are never retained', () => {
  const cache = createByteCache({ maxEntries: 3, maxBytes: 10, sizeOf: value => value.length });
  cache.set('a', 'aaaa'); cache.set('b', 'bbbb');
  assert.equal(cache.get('a'), 'aaaa');
  cache.set('c', 'cccc');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.calculatedSize, 8);
  cache.set('a', 'oversized value');
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.calculatedSize, 4);
  cache.set('c', 'c');
  assert.equal(cache.calculatedSize, 1);
  cache.clear();
  assert.equal(cache.calculatedSize, 0);
  assert.equal(cache.size, 0);
});

test('entry count and sliding idle expiry also release accounted bytes', () => {
  let time = 1;
  const cache = createByteCache({ maxEntries: 2, maxBytes: 100, sizeOf: value => value.length, ttl: 10, now: () => time });
  cache.set('a', 'a'); cache.set('b', 'bb'); cache.set('c', 'ccc');
  assert.equal(cache.get('a'), undefined);
  time = 6;
  cache.get('b');
  time = 12;
  cache.purgeStale();
  assert.equal(cache.size, 1);
  assert.equal(cache.calculatedSize, 2);
  time = 17;
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.calculatedSize, 0);
});

test('SVG response accounting includes link overlays as well as text', () => {
  const text = '<svg/>';
  assert.equal(svgImageBytes(text), text.length * 2);
  assert.ok(svgImageBytes({ svg: text, links: [{ href: 'https://example.com' }] }) > svgImageBytes(text));
});
