import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLibrarySearch, decodeSearchText, searchSnippets } from '../library/search.mjs';
import { parseSearchQuery, updateQueryQualifier, pathMatches, languageMatches, cardMatchLines } from '../library/search-query.mjs';
import { createLibraryRoutes } from '../library/routes.mjs';
import { MAX_SNIPPET_LINES, MAX_LINE_RANGES, MAX_RESULT_BYTES, searchFileBytes } from '../library/search-core.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'library-search-中文 space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'scripts'));
  for (let index = 0; index < 25; index++) await writeFile(join(root, 'src', `part-${String(index).padStart(2, '0')}.js`), 'const needle = "needle";\n');
  await writeFile(join(root, 'scripts', 'example.py'), 'needle = 1\n');
  await writeFile(join(root, '根文件.md'), '# needle\n😀needle 汉字\n');
  await writeFile(join(root, 'root.txt'), 'NEEDLE needle\n');
  await writeFile(join(root, 'root.txt.extra'), 'needle\n');
  await writeFile(join(root, 'binary.bin'), Buffer.concat([Buffer.from('needle\n'), Buffer.alloc(70000, 65), Buffer.from([0])]));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([110, 101, 101, 100, 108, 101, 255]));
  await writeFile(join(root, 'ascii.pdf'), '%PDF-1.7\nneedle\n%%EOF');
  await writeFile(join(root, 'renamed-data'), '%PDF-1.7\nneedle\n%%EOF');
  await writeFile(join(root, 'image.png'), 'needle');
  await writeFile(join(root, 'oversized.txt'), 'needle\n' + 'x'.repeat(2 * 1024 * 1024));
  for (const path of ['node_modules', 'src/node_modules', '.private', '.archive', '.work']) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'ignored.js'), 'needle\n');
  }
  await writeFile(join(root, '.gitignore'), 'src/\n');
  return root;
}

test('idle search snapshots expire without waiting for another search', async t => {
  const root = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const search = createLibrarySearch(root);
  const first = await search(new URLSearchParams({ q: 'needle' }));
  t.mock.timers.tick(300001);
  await assert.rejects(search(new URLSearchParams({ q: 'needle', searchId: first.searchId })), /expired/i);
});

test('text detection rejects binary data anywhere, invalid UTF-8 and ASCII PDF', () => {
  assert.equal(decodeSearchText(Buffer.from('汉字\t😀\r\ncode')), '汉字\t😀\r\ncode');
  for (const value of [Buffer.from('before\0after'), Buffer.from([0xff]), Buffer.from('needle\x01'), Buffer.from('%PDF-1.7\nneedle')])
    assert.equal(decodeSearchText(value), null);
});

test('literal snippets group nearby matches, retain UTF-16 highlight offsets and CRLF line numbers', () => {
  const result = searchSnippets('😀针🧵 针🧵\r\nnearby\r\n针🧵\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\r\n9\r\n针🧵', '针🧵');
  assert.equal(result.matchCount, 4);
  assert.equal(result.snippets.length, 2);
  assert.deepEqual(result.snippets[0].lines[0].ranges, [[2, 5], [6, 9]]);
  assert.equal(result.snippets[1].lines.at(-1).number, 11);
  assert.equal(result.snippetsTruncated, false);
  assert.deepEqual(result.snippets.flatMap(snippet => snippet.lines).map(line => line.number), [1, 3, 11]);
  assert.ok(result.snippets.flatMap(snippet => snippet.lines).every(line => line.ranges.length > 0));
  assert.equal(searchSnippets('a.b aXb A.B', 'a.b').matchCount, 2);
  assert.equal(searchSnippets('a.b aXb A.B', 'a.b', true).matchCount, 1);
});

test('excerpts remain bounded for large matching files and report hidden matches', () => {
  const result = searchSnippets('x'.repeat(20000), 'x');
  assert.equal(result.matchCount, 20000);
  assert.equal(result.snippets[0].lines[0].text.length, 1200);
  assert.deepEqual(result.snippets[0].lines[0].ranges, [[0, 1200]]);
  assert.equal(result.snippetsTruncated, true);
  const manyLines = searchSnippets(('needle\n' + 'context\n'.repeat(10)).repeat(500), 'needle');
  assert.equal(manyLines.matchCount, 500);
  assert.ok(manyLines.snippets.length <= MAX_SNIPPET_LINES);
  assert.ok(manyLines.snippets.flatMap(snippet => snippet.lines).length <= MAX_SNIPPET_LINES);
  assert.equal(manyLines.snippetsTruncated, true);
  assert.equal(searchSnippets('', '').matchCount, 0);
});

test('dense and zero-width regex results keep accurate counts with bounded highlight ranges', () => {
  const text = ('x '.repeat(600) + '\n').repeat(30);
  const result = searchSnippets(text, 'x', true, true);
  assert.equal(result.matchCount, 18000);
  assert.equal(result.snippetsTruncated, true);
  const lines = result.snippets.flatMap(snippet => snippet.lines);
  assert.equal(lines.length, MAX_SNIPPET_LINES);
  assert.ok(lines.every(line => line.ranges.length === MAX_LINE_RANGES));
  assert.deepEqual(lines[0].ranges[0], [0, 1]);
  assert.deepEqual(lines[0].ranges.at(-1), [(MAX_LINE_RANGES - 1) * 2, (MAX_LINE_RANGES - 1) * 2 + 1]);
  const zeroWidth = searchSnippets('x'.repeat(1000), '(?=x)', true, true);
  assert.equal(zeroWidth.matchCount, 1000);
  assert.equal(zeroWidth.snippets[0].lines[0].ranges.length, MAX_LINE_RANGES);
  assert.equal(zeroWidth.snippetsTruncated, true);
  const unicode = searchSnippets('😀'.repeat(1000), '.', true, true);
  assert.equal(unicode.matchCount, 1000);
  assert.deepEqual(unicode.snippets[0].lines[0].ranges, [[0, 1200]]);
});

test('search truncates at the retained-result budget and preserves pagination of admitted files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'library-search-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = ('x '.repeat(600) + '\n').repeat(MAX_SNIPPET_LINES);
  for (let index = 0; index < 100; index++) await writeFile(join(root, `${String(index).padStart(3, '0')}.txt`), content);
  const search = createLibrarySearch(root);
  let page = await search(new URLSearchParams({ q: '/x/' }));
  assert.equal(page.truncated, true);
  assert.ok(page.total > 20 && page.total < 100);
  const files = [...page.files];
  while (page.nextOffset !== null) {
    page = await search(new URLSearchParams({ q: '/x/', searchId: page.searchId, offset: String(page.nextOffset) }));
    files.push(...page.files);
  }
  assert.equal(files.length, page.total);
  assert.equal(new Set(files.map(file => file.path)).size, files.length);
  assert.ok(files.reduce((sum, file) => sum + searchFileBytes(file), 0) <= MAX_RESULT_BYTES);
  assert.equal(page.matchCount, files.length * MAX_SNIPPET_LINES * 600);
});

test('WASM search skips binaries, hidden/dependency folders and large files; filters and pages by file', async t => {
  const root = await fixture(t);
  const search = createLibrarySearch(root);
  const first = await search(new URLSearchParams({ q: 'needle' }));
  assert.equal(first.engine, 'ripgrep-wasm');
  assert.equal(first.total, 29);
  assert.equal(first.matchCount, 56);
  assert.equal(first.files.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.truncated, false);
  const second = await search(new URLSearchParams({ q: 'needle', searchId: first.searchId, offset: '20' }));
  assert.equal(second.files.length, 9);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.files, ...second.files].map(file => file.path)).size, 29);
  assert.ok([...first.files, ...second.files].some(file => file.path === '根文件.md'));
  const languages = Object.fromEntries(first.facets.languages.map(item => [item.value, item.count]));
  assert.deepEqual(languages, { JavaScript: 25, Text: 2, Markdown: 1, Python: 1 });
  const filtered = await search(new URLSearchParams({ q: 'needle', lang: 'Python', searchId: first.searchId }));
  assert.equal(filtered.total, 1);
  assert.equal(filtered.files[0].path, 'scripts/example.py');
  const source = await search(new URLSearchParams({ q: 'needle', path: 'src/', searchId: first.searchId }));
  assert.equal(source.total, 25);
  assert.deepEqual(source.facets.languages, [{ value: 'JavaScript', count: 25 }]);
  const exact = await search(new URLSearchParams({ q: 'needle', path: 'root.txt', searchId: first.searchId }));
  assert.equal(exact.total, 1);
  assert.equal(exact.matchCount, 2);
  const sensitive = await search(new URLSearchParams({ q: 'NEEDLE', case: 'true' }));
  assert.equal(sensitive.total, 1);
  assert.equal(sensitive.matchCount, 1);
});

test('search snapshots survive refresh and file edits without duplicate/missing pages', async t => {
  const root = await fixture(t);
  const search = createLibrarySearch(root);
  const first = await search(new URLSearchParams({ q: 'needle' }));
  await writeFile(join(root, 'new.js'), 'needle\n');
  const fresh = await search(new URLSearchParams({ q: 'needle', refresh: 'true' }));
  assert.equal(fresh.total, first.total + 1);
  assert.notEqual(fresh.searchId, first.searchId);
  const oldPage = await search(new URLSearchParams({ q: 'needle', searchId: first.searchId, offset: '20' }));
  assert.equal(oldPage.total, first.total);
  assert.equal(oldPage.files.length, 9);
  await assert.rejects(search(new URLSearchParams({ q: 'different', searchId: first.searchId })), /expired/i);
});

test('queries remain literal and never become shell options or commands', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'literal.txt'), '--help\n$(echo unwanted)\na.b\naXb\n针🧵\n');
  const search = createLibrarySearch(root);
  for (const query of ['--help', '$(echo unwanted)', 'a.b', '针🧵']) {
    const result = await search(new URLSearchParams({ q: query }));
    assert.equal(result.total, 1);
    assert.equal(result.matchCount, 1);
  }
  const missing = await search(new URLSearchParams({ q: 'this-query-does-not-exist' }));
  assert.equal(missing.total, 0);
  assert.equal(missing.nextOffset, null);
});

test('library HTTP search route returns results and validation errors', async t => {
  const root = await fixture(t);
  const app = createLibraryRoutes({ root, json: (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } }) });
  const response = await app.request('/api/search?q=needle&lang=Python');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).files[0].path, 'scripts/example.py');
  for (const query of ['', ' ', 'a\nb', 'a\0b', 'a'.repeat(257)]) {
    const response = await app.request(`/api/search?${new URLSearchParams({ q: query })}`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /single-line/i);
  }
  const expired = await app.request('/api/search?q=needle&searchId=missing');
  assert.equal(expired.status, 400);
  assert.match((await expired.json()).error, /expired/i);
});


test('query qualifiers support quoted phrases, paths and language aliases', () => {
  assert.deepEqual(parseSearchQuery('"const needle" lang:JS path:"source folder/"'), {
    text: 'const needle', languages: ['JS'], paths: [{ value: 'source folder/', quoted: true }],
  });
  assert.deepEqual(parseSearchQuery('needle path:src/**/*.js lang:javascript').paths, [{ value: 'src/**/*.js', quoted: false }]);
  assert.deepEqual(parseSearchQuery('needle language:javascript').languages, ['javascript']);
  assert.equal(languageMatches('JavaScript', ['js']), true);
  assert.equal(languageMatches('C++', ['cpp']), true);
  assert.equal(languageMatches('TypeScript', ['js']), false);
  assert.equal(parseSearchQuery('"path:src/"').text, 'path:src/');
  assert.equal(parseSearchQuery('"say \\"hi\\""').text, 'say "hi"');
  assert.throws(() => parseSearchQuery('needle path:'), /value/i);
  assert.throws(() => parseSearchQuery('needle path:"src'), /quotation/i);
  const updated = updateQueryQualifier('"const needle" language:js path:src/', 'lang', 'TypeScript');
  assert.equal(updated, '"const needle" path:src/ lang:TypeScript');
  assert.equal(updateQueryQualifier(updated, 'path', ''), '"const needle" lang:TypeScript');
  assert.equal(updateQueryQualifier('needle', 'path', 'folder with spaces/'), 'needle path:"folder with spaces/"');
});

test('GitHub-style paths support substring, anchored globs, recursive globs and quoted literals', () => {
  const matches = (path, value, quoted = false) => pathMatches(path, [{ value, quoted }]);
  assert.equal(matches('nested/src/main.js', 'src/'), true);
  assert.equal(matches('nested/src/main.js', 'src/*.js'), true);
  assert.equal(matches('nested/src/main.js', '/src/*.js'), false);
  assert.equal(matches('src/main.js', '/src/*.js'), true);
  assert.equal(matches('src/deep/main.js', '/src/*.js'), false);
  assert.equal(matches('src/deep/main.js', '/src/**/*.js'), true);
  assert.equal(matches('src/main.js', '/src/**/*.js'), true);
  assert.equal(matches('src/main.js', '*.js'), true);
  assert.equal(matches('src/main.ts', '*.js'), false);
  assert.equal(matches('src/file.abc', '*.a?c'), true);
  assert.equal(matches('src/file?name.js', 'file?', true), true);
  assert.equal(matches('src/fileXname.js', 'file?', true), false);
});

test('inline qualifiers filter the same snapshot and card excerpts contain only matching rows', async t => {
  const root = await fixture(t);
  const search = createLibrarySearch(root);
  const original = await search(new URLSearchParams({ q: 'needle' }));
  const js = await search(new URLSearchParams({ q: 'needle lang:js path:/src/**/*.js', searchId: original.searchId }));
  assert.equal(js.total, 25);
  assert.equal(js.searchId, original.searchId);
  assert.equal(js.nextOffset, 20);
  const second = await search(new URLSearchParams({ q: 'needle lang:js path:/src/**/*.js', searchId: original.searchId, offset: '20' }));
  assert.equal(second.files.length, 5);
  assert.equal(second.nextOffset, null);
  const python = await search(new URLSearchParams({ q: 'needle lang:python path:*.py', searchId: original.searchId }));
  assert.equal(python.total, 1);
  assert.equal(python.files[0].path, 'scripts/example.py');
  const spacedPath = join(root, 'space folder');
  await mkdir(spacedPath);
  await writeFile(join(spacedPath, 'example.js'), 'needle\nnot matched\nneedle\nnot matched\nneedle\nneedle\nneedle\nneedle\nneedle\n');
  const spaced = await search(new URLSearchParams({ q: 'needle path:"space folder/"', refresh: 'true' }));
  assert.equal(spaced.total, 1);
  const file = spaced.files[0];
  assert.equal(file.matchCount, 7);
  assert.deepEqual(cardMatchLines(file, false).map(line => line.number), [1, 3, 5, 6, 7]);
  assert.deepEqual(cardMatchLines(file, true).map(line => line.number), [1, 3, 5, 6, 7, 8, 9]);
  assert.ok(cardMatchLines(file, true).every(line => line.ranges.length && line.text === 'needle'));
  const phrase = await search(new URLSearchParams({ q: '"const needle" lang:js' }));
  assert.equal(phrase.total, 25);
});

test('case qualifier replaces the toggle and current file sorts before pagination', async t => {
  const root = await fixture(t);
  const search = createLibrarySearch(root);
  const sensitive = await search(new URLSearchParams({ q: 'NEEDLE case:yes' }));
  assert.equal(sensitive.total, 1);
  assert.equal(sensitive.matchCount, 1);
  const insensitive = await search(new URLSearchParams({ q: 'NEEDLE case:no' }));
  assert.equal(insensitive.total, 29);
  const preferred = await search(new URLSearchParams({ q: 'needle', currentFile: '根文件.md' }));
  assert.equal(preferred.files[0].path, '根文件.md');
  assert.equal(parseSearchQuery('needle case:yes').text, 'needle');
  assert.throws(() => parseSearchQuery('needle case:maybe'), /case:yes/);
});

test('regex syntax preserves spaces, escapes and qualifiers and accepts only i', () => {
  const parsed = parseSearchQuery('/function\\s+\\w+/i lang:js path:src/');
  assert.equal(parsed.text, 'function\\s+\\w+');
  assert.equal(parsed.regex, true);
  assert.equal(parsed.caseSensitive, false);
  assert.equal(parseSearchQuery('/TODO/ case:no').caseSensitive, true);
  assert.equal(parseSearchQuery('/TODO/i case:yes').caseSensitive, false);
  assert.equal(parseSearchQuery('/hello world/').text, 'hello world');
  assert.equal(parseSearchQuery('/src\\/main/').text, 'src/main');
  assert.equal(parseSearchQuery('/[/]/').text, '[/]');
  assert.equal(parseSearchQuery('"/TODO/i"').text, '/TODO/i');
  assert.equal(parseSearchQuery('"/TODO/i"').regex, undefined);
  assert.equal(updateQueryQualifier('/hello world/i lang:js', 'path', 'src/'), '/hello world/i lang:js path:src/');
  for (const query of ['/TODO/g', '/TODO/m', '/TODO/s', '/TODO/u', '/TODO/ii'])
    assert.throws(() => parseSearchQuery(query), /Only the i flag/);
  assert.throws(() => parseSearchQuery('/TODO'), /Close the regular expression/);
  assert.throws(() => parseSearchQuery('//'), /non-empty/);
  assert.throws(() => parseSearchQuery('/(/'), /Invalid regular expression/);
  assert.throws(() => parseSearchQuery('/TODO/ extra'), /one regular expression/);
});

test('regex search uses one engine for file detection and highlighted ranges, with stable snapshots', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'regex.js'), 'TODO todo FIXME\r\nfunction hello()\r\nsrc/main\r\n😀TODO\r\n');
  const search = createLibrarySearch(root);
  const sensitive = await search(new URLSearchParams({ q: '/TODO|FIXME/ lang:js' }));
  assert.equal(sensitive.total, 1);
  assert.equal(sensitive.matchCount, 3);
  assert.deepEqual(sensitive.files[0].snippets[0].lines[0].ranges, [[0, 4], [10, 15]]);
  assert.deepEqual(sensitive.files[0].snippets[0].lines[1].ranges, [[2, 6]]);
  const insensitive = await search(new URLSearchParams({ q: '/TODO|FIXME/i' }));
  assert.equal(insensitive.matchCount, 4);
  assert.notEqual(insensitive.searchId, sensitive.searchId);
  const spaced = await search(new URLSearchParams({ q: '/function \\w+/' }));
  assert.equal(spaced.matchCount, 1);
  assert.equal(spaced.files[0].snippets[0].lines[0].number, 2);
  const lookbehind = await search(new URLSearchParams({ q: '/(?<=function )\\w+/' }));
  assert.deepEqual(lookbehind.files[0].snippets[0].lines[0].ranges, [[9, 14]]);
  assert.equal((await search(new URLSearchParams({ q: '/src\\/main/' }))).total, 1);
  assert.equal((await search(new URLSearchParams({ q: '/TODO\\nfunction/' }))).total, 0);
  const first = await search(new URLSearchParams({ q: '/needle/i' }));
  assert.equal(first.total, 29);
  const page = await search(new URLSearchParams({ q: '/needle/i', searchId: first.searchId, offset: '20' }));
  assert.equal(page.files.length, 9);
  await assert.rejects(search(new URLSearchParams({ q: 'needle', searchId: first.searchId })), /expired/);
  const zeroWidth = await search(new URLSearchParams({ q: '/^/ path:regex.js' }));
  assert.equal(zeroWidth.total, 1);
  assert.ok(zeroWidth.files[0].snippets.flatMap(snippet => snippet.lines).every(line => line.ranges.length));
});

test('HTTP regex validation rejects unsupported flags and malformed patterns', async t => {
  const root = await fixture(t);
  const app = createLibraryRoutes({ root, json: (value, status = 200) => Response.json(value, { status }) });
  for (const q of ['/needle/g', '/(/', '/needle', '//']) {
    const response = await app.request(`/api/search?${new URLSearchParams({ q })}`);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  const response = await app.request('/api/search?q=%2Fneedle%2Fi');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 29);
});
