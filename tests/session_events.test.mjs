import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentOpenEvent } from '../library/session-events.mjs';

test('native connection events and malformed messages do not trigger document navigation', () => {
  for (const data of [undefined, '', 'undefined', '{', 'null', '[]', '{}', '{"url":false,"repo":"repo"}'])
    assert.equal(parseDocumentOpenEvent({ data }), null);
});

test('document open messages remain compatible with legacy event names', () => {
  const request = { repo: 'notes', path: '中文 folder/a #.md', url: '/notes/tree/a.md' };
  for (const type of ['open', 'document-open'])
    assert.deepEqual(parseDocumentOpenEvent({ type, data: JSON.stringify(request) }), request);
});
