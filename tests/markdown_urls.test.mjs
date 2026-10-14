import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarkdownUrl } from '../web/markdown/url.mjs';

test('Markdown URLs resolve against the document and retain query and fragment', () => {
  assert.deepEqual(resolveMarkdownUrl('../images/a%20b.png?size=2#preview', 'docs/chapter.md'), {
    path: 'images/a b.png', search: '?size=2', hash: '#preview',
  });
  assert.deepEqual(resolveMarkdownUrl('?mode=print', 'docs/chapter.md'), {
    path: 'docs/chapter.md', search: '?mode=print', hash: '',
  });
  assert.deepEqual(resolveMarkdownUrl('/assets/图.png', 'docs/chapter.md'), {
    path: 'assets/图.png', search: '', hash: '',
  });
  assert.deepEqual(resolveMarkdownUrl('../数学/公式%20%231%25.md', 'docs/chapter.md'), {
    path: '数学/公式 #1%.md', search: '', hash: '',
  });
  assert.equal(resolveMarkdownUrl('../100%.md', 'docs/chapter.md').path, '100%.md');
  assert.equal(resolveMarkdownUrl('bad%escape', 'docs/chapter.md').path, 'docs/bad%escape');
  assert.deepEqual(resolveMarkdownUrl('../百分比%25.md', 'docs/chapter.md'), {
    path: '百分比%.md', search: '', hash: '',
  });
  for (const value of ['../../outside.md', 'https://example.com/a', '//example.com/a', '#section']) {
    assert.equal(resolveMarkdownUrl(value, 'docs/chapter.md'), null, value);
  }
});
