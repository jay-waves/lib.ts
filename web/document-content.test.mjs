import assert from 'node:assert/strict';
import test from 'node:test';
import { changedAssetPaths, sameDocumentContent } from './document-content.ts';

const base = { path: 'sample', absolutePath: '/library/sample', name: 'sample', size: 10, modified: 'version-1' };

test('identical revalidation results preserve content for every preview format', () => {
  for (const content of [
    { type: 'binary', mime: 'video/mp4', url: '/media' },
    { type: 'image', mime: 'image/png', format: 'png', url: '/asset' },
    { type: 'pdf', revision: 'pdf-1', pages: [], outline: [] },
    { type: 'typst', source: 'hello', compile: { id: 'compile-1', status: 'success', diagnostics: [] } },
    { type: 'markdown', source: 'hello', html: '<p>hello</p>', lineCount: 1 },
    { type: 'text', source: 'hello', lineCount: 1, outline: [] },
  ]) {
    const document = { ...base, ...content };
    assert.equal(sameDocumentContent(document, structuredClone(document)), true, content.type);
  }
});

test('changes beyond source modification time still replace content', () => {
  for (const [previous, next] of [
    [{ type: 'pdf', revision: 'pdf-1' }, { type: 'pdf', revision: 'pdf-2' }],
    [{ type: 'typst', compile: { id: 'compile-1' } }, { type: 'typst', compile: { id: 'compile-2' } }],
    [{ type: 'text', source: 'before' }, { type: 'text', source: 'after' }],
    [{ type: 'markdown', source: 'hello' }, { type: 'markdown', source: 'hello', html: '<p>hello</p>' }],
    [{ type: 'image', preview: 'original' }, { type: 'image', preview: 'converted' }],
  ]) assert.equal(sameDocumentContent({ ...base, ...previous }, { ...base, ...next }), false);
});

test('connecting or reconnecting with unchanged assets does not reload them', () => {
  const snapshot = { 'image.png': 'version-1', 'missing.png': null };
  assert.deepEqual(changedAssetPaths({}, snapshot), []);
  assert.deepEqual(changedAssetPaths(snapshot, { ...snapshot }), []);
});

test('reconnecting detects modified, deleted and newly available assets', () => {
  const before = { modified: 'version-1', deleted: 'version-1', created: null, unchanged: 'version-1' };
  const after = { modified: 'version-2', deleted: null, created: 'version-1', unchanged: 'version-1' };
  assert.deepEqual(changedAssetPaths(before, after), ['modified', 'deleted', 'created']);
});
