import test from 'node:test';
import assert from 'node:assert/strict';
import { documentSchema, getDocument, watchDocument } from '../web/api/documents.ts';

const identity = { path: '文档/a & b.md', absolutePath: '/notes/文档/a & b.md', name: 'a & b.md' };
const metadata = { size: 12, modified: '2026-10-16T00:00:00Z' };
const source = { source: '# Heading\n', lineCount: 1 };
const page = { url: '/notes/api/pdf/page?path=a.pdf&page=1', width: 600, height: 800 };
const markdown = { ...identity, ...metadata, ...source, type: 'markdown', html: '<h1>Heading</h1>' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('document contract accepts all formats and both raw and compiled Typst', () => {
  const typst = { ...identity, ...metadata, ...source, type: 'typst', pages: [], outline: [], anchors: [], compile: null };
  const formats = [
    markdown,
    { ...identity, ...metadata, ...source, type: 'markdown' },
    { ...identity, ...source, type: 'text', outline: [] },
    { ...identity, type: 'text', source: 'class App { run() {} }', lineCount: 1,
      outline: [{ name: 'App', level: 1, line: 1 }, { name: 'run', level: 2, line: 1 }] },
    { ...identity, ...metadata, ...source, type: 'html', url: '/notes/api/html?path=a.html' },
    { ...identity, ...metadata, type: 'image', mime: 'image/png', format: 'png', url: '/notes/api/asset?path=a.png' },
    { ...identity, ...metadata, type: 'binary', mime: 'application/octet-stream', url: '/notes/api/asset?path=a.bin' },
    { ...identity, ...metadata, type: 'pdf', revision: 'snapshot', pages: [page], outline: [
      { name: 'Group', level: 1 }, { name: 'Page', level: 2, page: 1, y: 0.5 },
    ] },
    typst,
    { ...typst, pages: [page], outline: [{ name: 'Title', level: 1, line: 1, position: { page: 1, y: 0.2 } }],
      anchors: [{ line: 1, page: 1, y: 0.2, absoluteY: 100 }],
      compile: { id: 'snapshot', status: 'success', diagnostics: [] } },
    { ...typst, compile: { id: null, status: 'failed', diagnostics: [
      { file: 'a.typ', severity: 'error', message: 'Syntax error', range: null },
      { file: 'a.typ', severity: 'error', message: 'Missing expression',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
    ] } },
  ];
  for (const format of formats) assert.deepEqual(documentSchema.parse(format), format);
  const { lineCount, ...wrongField } = markdown;
  assert.equal(documentSchema.safeParse({ ...wrongField, line_count: lineCount }).success, false);
  assert.equal(documentSchema.safeParse({ ...markdown, type: 'unknown' }).success, false);
});

test('document requests encode paths, pass cancellation and preserve API errors', async t => {
  const controller = new AbortController();
  const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    const target = new URL(url, 'http://localhost');
    assert.equal(target.pathname, '/notes/api/document');
    assert.deepEqual(Object.fromEntries(target.searchParams), { path: identity.path, view: 'raw', theme: 'dark' });
    assert.equal(init.signal, controller.signal);
    return json(markdown);
  });
  assert.deepEqual(await getDocument('/notes/api', identity.path, 'raw', 'dark', controller.signal), markdown);
  mock.mock.mockImplementation(async () => json({ error: 'Not found' }, 404));
  await assert.rejects(getDocument('/notes/api', 'missing', 'preview', 'light'), error => error.status === 404 && error.message === 'Not found');
  mock.mock.mockImplementation(async () => json({ ...markdown, lineCount: '1' }));
  await assert.rejects(getDocument('/notes/api', 'broken', 'preview', 'light'), /Invalid API response/);
  mock.mock.mockImplementation(async (_url, { signal }) => { signal.throwIfAborted(); });
  controller.abort();
  await assert.rejects(getDocument('/notes/api', identity.path, 'raw', 'dark', controller.signal), { name: 'AbortError' });
});

test('document SSE validates payloads, preserves assets and reconnects after visibility changes', t => {
  const doc = new EventTarget(), win = new EventTarget(), streams = [];
  doc.hidden = false;
  class EventSource extends EventTarget {
    constructor(url) { super(); this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  for (const [key, value] of Object.entries({ document: doc, window: win, EventSource })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  const errors = t.mock.method(console, 'error', () => {});
  const received = [];
  const subscription = watchDocument('/notes/api', identity.path, ['a & b.png', '中文.svg'], {
    connected: payload => received.push(['connected', payload]),
    document: () => received.push(['document']),
    assets: payload => received.push(['assets', payload]),
  });
  t.after(() => subscription.close());
  const target = new URL(streams[0].url, 'http://localhost');
  assert.equal(target.searchParams.get('path'), identity.path);
  assert.deepEqual(target.searchParams.getAll('asset'), ['a & b.png', '中文.svg']);
  const emit = (name, data) => streams.at(-1).dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  emit('connected', { modified: metadata.modified });
  emit('document', {});
  emit('assets', { paths: ['中文.svg'] });
  emit('connected', { modified: [] });
  emit('assets', { paths: 'invalid' });
  streams[0].dispatchEvent(new MessageEvent('assets', { data: '{' }));
  assert.equal(errors.mock.callCount(), 3);
  assert.deepEqual(received, [
    ['connected', { modified: metadata.modified }], ['document'], ['assets', { paths: ['中文.svg'] }],
  ]);
  doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(streams[0].closed, true);
  doc.hidden = false; doc.dispatchEvent(new Event('visibilitychange'));
  emit('connected', { modified: 'new revision' });
  assert.deepEqual(received.at(-1), ['connected', { modified: 'new revision' }]);
  subscription.close();
  assert.equal(streams[1].closed, true);
});
