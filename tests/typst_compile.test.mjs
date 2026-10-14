import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTypstVector } from '../server/typst/compile.mjs';

function fakeCompiler({ failCompile = false, failExport = false, error = false } = {}) {
  const calls = [], document = {}, diagnostic = {};
  return { calls, document,
    addSource(file, source) { calls.push(['source', file, source]); },
    compile(options) {
      calls.push(['compile', options]);
      if (failCompile) throw new Error('compile failed');
      return { result: error ? null : document,
        takeError: () => error ? diagnostic : null,
        takeWarnings: () => error ? null : diagnostic };
    },
    fetchDiagnostics(value) {
      assert.equal(value, diagnostic);
      return [{ severity: error ? 'error' : 'warning', message: 'diagnostic' }];
    },
    query(value) { assert.equal(value, document); calls.push(['query']); return [{ value: 'anchor' }]; },
    vector(value) {
      assert.equal(value, document); calls.push(['vector']);
      if (failExport) throw new Error('export failed');
      return Buffer.from('vector');
    },
    unmapShadow(file) { calls.push(['unmap', file]); },
    evictCache(age) { calls.push(['evict', age]); },
  };
}

test('native compile queries and exports one document before aging caches', () => {
  const compiler = fakeCompiler();
  const result = compileTypstVector(compiler, 'note.typ', 'source', { queryAnchors: true, inputs: { theme: 'dark' } });
  assert.deepEqual(result.artifact, Buffer.from('vector'));
  assert.deepEqual(result.anchors, [{ value: 'anchor' }]);
  assert.equal(result.diagnostics[0].severity, 'warning');
  assert.deepEqual(compiler.calls.map(call => call[0]), ['source', 'compile', 'query', 'vector', 'unmap', 'evict']);
  assert.deepEqual(compiler.calls[1][1].inputs, { theme: 'dark' });
  assert.equal(compiler.calls[1][1].resetRead, true);
  assert.deepEqual(compiler.calls.at(-1), ['evict', 30]);
  compileTypstVector(compiler, 'other.typ', 'source');
  assert.deepEqual(compiler.calls.filter(call => call[0] === 'compile').at(-1)[1].inputs, {});
});

test('diagnostic failures return without exporting and still release overlays and age caches', () => {
  const compiler = fakeCompiler({ error: true });
  const result = compileTypstVector(compiler, 'note.typ', 'bad source');
  assert.equal(result.artifact, undefined);
  assert.equal(result.diagnostics[0].severity, 'error');
  assert.deepEqual(compiler.calls.map(call => call[0]), ['source', 'compile', 'unmap', 'evict']);
});

for (const stage of ['Compile', 'Export']) test(`native ${stage.toLowerCase()} exceptions still clean up`, () => {
  const compiler = fakeCompiler({ [`fail${stage}`]: true });
  assert.throws(() => compileTypstVector(compiler, 'note.typ', 'source'), /failed/);
  assert.deepEqual(compiler.calls.slice(-2).map(call => call[0]), ['unmap', 'evict']);
});
