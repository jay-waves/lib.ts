import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepTypstCache } from '../server/typst/cache.mjs';

test('active Typst files protect only their latest revision, with a transition grace period', () => {
  const item = (id, lastUsed, inUse = 0) => ({ id, file: 'note.typ', lastUsed, inUse });
  const cache = new Map(['old', 'busy', 'recent', 'latest'].map((id, index) =>
    [id, item(id, index === 2 ? 90000 : 0, index === 1 ? 1 : 0)]));
  const options = { now: 100000, isActive: () => true, fileKey: file => file };
  sweepTypstCache(cache, options);
  assert.deepEqual([...cache.keys()], ['busy', 'recent', 'latest']);
  cache.get('busy').inUse = 0;
  sweepTypstCache(cache, { ...options, now: 1000000 });
  assert.deepEqual([...cache.keys()], ['latest']);
});

test('idle Typst artifacts expire without evicting a protected response', () => {
  const cache = new Map(['idle', 'protected'].map(id => [id,
    { id, file: id, lastUsed: 0, inUse: 0 }]));
  const options = { isActive: () => false, fileKey: file => file, protectedId: 'protected' };
  sweepTypstCache(cache, { ...options, now: 300000 });
  assert.equal(cache.size, 2);
  sweepTypstCache(cache, { ...options, now: 900000 });
  assert.deepEqual([...cache.keys()], ['protected']);
});

test('rapid revisions keep only the latest two even inside the grace period', () => {
  const cache = new Map(Array.from({ length: 30 }, (_, id) => [id,
    { id, file: 'note.typ', lastUsed: 1000, inUse: 0, artifactBytes: 10 }]));
  sweepTypstCache(cache, { now: 1000, isActive: () => true, fileKey: file => file });
  assert.deepEqual([...cache.keys()], [28, 29]);
});

test('source snapshot bytes and entry limits bound the metadata cache independently of artifacts', () => {
  const cache = new Map(['old', 'middle', 'current'].map((id, index) => [id,
    { id, file: id, lastUsed: index, inUse: 0, request: { source: 'x'.repeat(20) } }]));
  const options = { now: 10, isActive: () => true, fileKey: file => file, protectedId: 'current' };
  sweepTypstCache(cache, { ...options, maxBytes: 90 });
  assert.deepEqual([...cache.keys()], ['middle', 'current']);
  sweepTypstCache(cache, { ...options, limit: 1 });
  assert.deepEqual([...cache.keys()], ['current']);
});

test('old-page reads cannot extend the revision transition deadline', () => {
  const old = { id: 'old', file: 'note', lastUsed: 1000, inUse: 0 };
  const latest = { id: 'latest', file: 'note', lastUsed: 1000, inUse: 0 };
  const cache = new Map([['old', old], ['latest', latest]]);
  const options = { isActive: () => true, fileKey: file => file };
  sweepTypstCache(cache, { ...options, now: 1000 });
  old.lastUsed = 16000;
  sweepTypstCache(cache, { ...options, now: 16000 });
  assert.deepEqual([...cache.keys()], ['latest']);
});

test('busy snapshots survive pressure until released; a single oversized source remains usable', () => {
  const busy = { id: 'busy', file: 'busy', lastUsed: 0, inUse: 1, request: { source: 'x'.repeat(40) } };
  const current = { id: 'current', file: 'current', lastUsed: 1, inUse: 0, request: { source: 'x'.repeat(60) } };
  const cache = new Map([['busy', busy], ['current', current]]);
  const options = { now: 10, isActive: () => true, fileKey: file => file, maxBytes: 100 };
  sweepTypstCache(cache, { ...options, protectedId: 'current' });
  assert.equal(cache.size, 2);
  busy.inUse = 0;
  sweepTypstCache(cache, options);
  assert.deepEqual([...cache.keys()], ['current']);
  sweepTypstCache(cache, options);
  assert.equal(cache.size, 1);
});

test('theme variants have independent revision histories', () => {
  const cache = new Map(['light1', 'dark1', 'light2', 'dark2', 'light3'].map((id, index) => [id,
    { id, file: 'note.typ', theme: id.startsWith('light') ? 'light' : 'dark', lastUsed: index, inUse: 0 }]));
  sweepTypstCache(cache, { now: 10, isActive: () => true, fileKey: file => file,
    versionKey: item => `${item.file}:${item.theme}`, limit: 10 });
  assert.deepEqual([...cache.keys()], ['dark1', 'light2', 'dark2', 'light3']);
});
