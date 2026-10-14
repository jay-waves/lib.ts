import test from 'node:test';
import assert from 'node:assert/strict';
import { typstInputs, typstCompilationKey } from '../server/typst/inputs.mjs';

test('preview passes theme with a light default and isolates light/dark compilation caches', () => {
  assert.deepEqual(typstInputs(), { theme: 'light' });
  assert.deepEqual(typstInputs('dark'), { theme: 'dark' });
  assert.throws(() => typstInputs('auto'), /light or dark/);
  const key = inputs => typstCompilationKey('note.typ', 1, inputs);
  assert.notEqual(key(typstInputs('light')), key(typstInputs('dark')));
  assert.equal(key({ a: '1', b: '2' }), key({ b: '2', a: '1' }));
});
