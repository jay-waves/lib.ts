import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../web/random-id.mjs';

test('randomId works when randomUUID is unavailable in an insecure HTTP context', () => {
  const cryptoProvider = { getRandomValues(bytes) { bytes.fill(0); return bytes; } };
  const id = randomId(cryptoProvider);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
