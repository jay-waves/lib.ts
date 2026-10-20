import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery, updateQueryQualifier, cardMatchLines } from '../web/search/search-query.ts';

test('regex flags and repeated qualifiers preserve search semantics', () => {
  const parsed = parseSearchQuery('/TODO|FIXME/i lang:js language:ts path:src/ path:"literal*" case:yes gitignore:no');
  assert.equal(parsed.text, 'TODO|FIXME');
  assert.equal(parsed.regex, true);
  assert.equal(parsed.caseSensitive, false);
  assert.equal(parsed.respectGitignore, false);
  assert.deepEqual(parsed.languages, ['js', 'ts']);
  assert.deepEqual(parsed.paths, [{ value: 'src/', quoted: false }, { value: 'literal*', quoted: true }]);
  assert.equal(parseSearchQuery('case:yes case:no gitignore:no gitignore:yes').caseSensitive, false);
  assert.equal(parseSearchQuery('gitignore:no gitignore:yes').respectGitignore, true);
});

test('qualifier editing retains regexes and quotes literal paths', () => {
  const query = '/TODO|FIXME/i language:js lang:ts path:src/ gitignore:no';
  assert.equal(updateQueryQualifier(query, 'language', 'md'), '/TODO|FIXME/i path:src/ gitignore:no lang:md');
  const updated = updateQueryQualifier(query, 'path', 'dir "a"\\literal*');
  assert.deepEqual(parseSearchQuery(updated).paths, [{ value: 'dir "a"\\literal*', quoted: true }]);
  assert.equal(parseSearchQuery(updateQueryQualifier(query, 'lang', '')).languages.length, 0);
});

test('invalid queries report errors instead of changing to a literal search', () => {
  for (const query of ['/unclosed', '/[/', '/x/g', '/x/ text', 'lang:', 'case:maybe', 'gitignore:maybe', '"unclosed']) {
    assert.throws(() => parseSearchQuery(query), Error, query);
  }
  assert.equal(parseSearchQuery('"/literal"').regex, undefined);
  assert.equal(parseSearchQuery('你好 😀').text, '你好 😀');
});

test('cards retain matching line order, collapse to five and support empty clipped snippets', () => {
  const lines = Array.from({ length: 8 }, (_, index) => ({ number: index + 1, ranges: index === 0 ? [] : [[0, 1]] }));
  const file = { snippets: [{ lines: lines.slice(0, 3) }, { lines: lines.slice(3) }] };
  assert.deepEqual(cardMatchLines(file, false).map(line => line.number), [2, 3, 4, 5, 6]);
  assert.deepEqual(cardMatchLines(file, true).map(line => line.number), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(cardMatchLines({ snippets: [{ lines: [{ number: 1, clipped: true, ranges: [] }] }] }, false), []);
});
