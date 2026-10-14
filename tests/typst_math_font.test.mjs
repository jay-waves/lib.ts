import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTypstRuntime } from '../server/typst/runtime.mjs';
import { compileTypstVector } from '../server/typst/compile.mjs';
import { bundledFontsDirectory } from '../server/typst/fonts.mjs';

test('bundled New Computer Modern supports math alphabets and quaternion group formulas', async t => {
  const file = resolve(bundledFontsDirectory, 'NewCMMath-Regular.otf');
  if (process.env.TYPST_WASM_FONTS) {
    t.skip('Requires the bundled default font list');
    return;
  }
  const data = readFileSync(file);
  const tables = Array.from({ length: data.readUInt16BE(4) }, (_, i) => data.toString('ascii', 12 + 16*i, 16 + 16*i));
  assert.ok(tables.includes('MATH'));
  const runtime = createTypstRuntime();
  const { compiler } = await runtime.init();
  const source = '#show math.equation: set text(font: "New Computer Modern Math")\n'
    + '$ cal(R) quad bb(R) quad frak(R) $\n\n'
    + '$ "SO"(3) = {R in RR^(3 times 3) | R^top R = I, det(R) = 1} $\n\n'
    + '$ "Sp"(1) = { q in HH | norm(q) = 1} $\n\n'
    + '$ "Sp"(1) tilde.equiv "SU"(2) tilde.equiv S^3 $\n\n'
    + '$ "Sp"(1)\\/{plus.minus 1} tilde.equiv "SO"(3) $';
  const result = await compileTypstVector(compiler, '/quaternion-font-check.typ', source);
  assert.ok(result.artifact, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'
    || /not designed for math|unknown font family|missing glyph/i.test(item.message)), []);
});
