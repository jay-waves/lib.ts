import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTypstVector } from '../typst-compile.mjs';

test('downloads missing preview packages and retries compilation', async () => {
  const missing = ['cetz:0.5.2', 'oxifmt:1.0.0'];
  const loaded = [];
  const compiler = {
    addSource() {},
    async runWithWorld(_options, action) {
      return action({
        async compile() {
          const spec = missing[loaded.length];
          return spec
            ? { hasError: true, diagnostics: [{ severity: 'error',
              message: `package not found (searched for @preview/${spec})` }] }
            : { hasError: false, diagnostics: [] };
        },
        async vector() { return { result: 'rendered' }; },
      });
    },
  };
  const result = await compileTypstVector(compiler, '/workspace/test.typ', 'example', {
    async loadMissingPackage(name, version) { loaded.push(`${name}:${version}`); return true; },
  });
  assert.equal(result.artifact, 'rendered');
  assert.deepEqual(loaded, missing);
});
