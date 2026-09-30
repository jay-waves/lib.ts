const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('transport isolates views, encodes events, reconnects and stops dispatch after close', async () => {
  const streams = [], requests = [];
  const context = vm.createContext({ URL, encodeURIComponent,
    location: { href: 'http://localhost:123/markdown/?t=a%26b' },
    fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return { ok: true, json: async () => ({ content: 'hello' }) };
    },
    EventSource: class {
      constructor(url) { this.url = new URL(url); this.handlers = {}; streams.push(this); }
      addEventListener(name, handler) { this.handlers[name] = handler; }
      close() { this.closed = true; }
    },
  });
  vm.runInContext(fs.readFileSync('src/shared/preview-client.js', 'utf8').replace('export function', 'function'), context);
  const markdown = context.createClient();
  context.location.href = 'http://localhost:123/typst/index.html?t=other';
  const typst = context.createClient();
  assert.equal(new URL(markdown.url('/document')).pathname, '/markdown/document');
  assert.equal(new URL(typst.url('/state')).pathname, '/typst/state');
  assert.equal(new URL(markdown.url('/document')).searchParams.get('t'), 'a&b');
  assert.equal((await markdown.get('/document')).content, 'hello');
  await markdown.send('click & jump', { document: '中文 &?#', line: 4 });
  assert.equal(requests[1].url.searchParams.get('event'), 'click & jump');
  assert.equal(JSON.parse(requests[1].url.searchParams.get('data')).document, '中文 &?#');
  let opens = 0, updates = 0, closes = 0;
  markdown.connect({ events: { reload: () => updates++ }, closeEvent: 'ended',
    onOpen: () => opens++, onClose: () => closes++ });
  const stream = streams[0];
  stream.onopen(); stream.onopen();
  stream.handlers.reload({ data: 'broken' });
  stream.handlers.reload({ data: '{}' });
  assert.equal(opens, 2, 'native reconnection must trigger refresh');
  assert.equal(updates, 1);
  stream.handlers.ended(); stream.handlers.ended();
  stream.handlers.reload({ data: '{}' }); stream.onopen();
  assert.equal(stream.closed, true);
  assert.equal(updates, 1); assert.equal(opens, 2); assert.equal(closes, 1);
});
