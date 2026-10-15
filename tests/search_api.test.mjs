import test from 'node:test';
import assert from 'node:assert/strict';
import { searchRepository } from '../web/api/search.ts';

const response = (overrides = {}) => ({
  query: '你好 & /TODO|FIXME/i', textQuery: 'TODO|FIXME', scope: 'files', searchId: 'snapshot',
  engine: 'ripgrep', truncated: false, total: 1, matchCount: 1,
  files: [{ path: '文档/Guide.md', language: 'Markdown', matchCount: 1, snippetsTruncated: false,
    snippets: [{ lines: [{ number: 3, text: '😀 TODO', clipped: false, ranges: [[3, 7]] }] }] }],
  nextOffset: null, facets: { languages: [{ value: 'Markdown', count: 1 }], paths: [] },
  ...overrides,
});
const request = { query: '你好 & /TODO|FIXME/i', currentFile: '文档/a & b.md', scope: '' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// These tests mock fetch only; URL construction and runtime JSON validation stay real.
test('repository search preserves query encoding, current file and cancellation signal', async t => {
  const controller = new AbortController();
  let url, options;
  t.mock.method(globalThis, 'fetch', async (input, init) => { url = new URL(input, 'http://localhost'); options = init; return json(response()); });
  const result = await searchRepository('/notes/api', { ...request, refresh: true }, controller.signal);
  assert.equal(url.pathname, '/notes/api/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), { q: request.query, currentFile: request.currentFile, refresh: 'true' });
  assert.equal(options.signal, controller.signal);
  assert.deepEqual(result, response());
});

test('current file scope and snapshot pages preserve their request parameters', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async input => { urls.push(new URL(input, 'http://localhost')); return json(response({ scope: 'current-file' })); });
  await searchRepository('/notes/api', { ...request, scope: 'current-file', searchId: 'snapshot' });
  await searchRepository('/notes/api', { ...request, scope: 'current-file', searchId: 'snapshot', offset: 20 });
  assert.equal(urls[0].searchParams.has('offset'), false);
  assert.equal(urls[0].searchParams.has('refresh'), false);
  assert.equal(urls[1].searchParams.get('scope'), 'current-file');
  assert.equal(urls[1].searchParams.get('searchId'), 'snapshot');
  assert.equal(urls[1].searchParams.get('offset'), '20');
});

test('expired snapshots retain the backend message and HTTP status', async t => {
  t.mock.method(globalThis, 'fetch', async () => json({ error: 'Search expired. Run the search again.' }, 400));
  await assert.rejects(searchRepository('/notes/api', { ...request, searchId: 'snapshot', offset: 20 }),
    error => error.status === 400 && error.message === 'Search expired. Run the search again.');
});

test('malformed responses and mismatched snapshots cannot become search results', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => json(response({ files: [{}] })));
  await assert.rejects(searchRepository('/notes/api', { ...request, refresh: true }), /Invalid API response/);
  mock.mock.mockImplementation(async () => json(response({ searchId: 'other' })));
  await assert.rejects(searchRepository('/notes/api', { ...request, searchId: 'snapshot', offset: 20 }), /snapshot changed/);
});

test('search cancellation propagates and invalid offsets never reach fetch', async t => {
  const controller = new AbortController();
  controller.abort();
  const mock = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => { signal.throwIfAborted(); });
  await assert.rejects(searchRepository('/notes/api', { ...request, refresh: true }, controller.signal), { name: 'AbortError' });
  for (const offset of [-1, 1.5, NaN, Infinity]) {
    await assert.rejects(searchRepository('/notes/api', { ...request, searchId: 'snapshot', offset }), /Invalid search offset/);
  }
  assert.equal(mock.mock.callCount(), 1);
});


test('an unsupported scope from an untyped caller fails instead of searching the repository', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => json(response()));
  await assert.rejects(searchRepository('/notes/api', { ...request, scope: 'invalid-url-scope', refresh: true }), /Unsupported search scope/);
  assert.equal(mock.mock.callCount(), 0);
});
