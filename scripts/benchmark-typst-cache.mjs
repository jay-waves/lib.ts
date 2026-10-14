// Compiler-only diagnostic, independent of service and renderer caches.
// PROBE_NO_EVICT=1 disables eviction for the compiler-only control.
import { createTypstRuntime } from '../server/typst/runtime.mjs';
import { compileTypstVector } from '../server/typst/compile.mjs';

const rounds = Number(process.env.PROBE_ROUNDS || 1500);

const runtime = createTypstRuntime();
const { compiler } = await runtime.init();
const evict = compiler.evictCache.bind(compiler);
if (process.env.PROBE_NO_EVICT === '1') compiler.evictCache = () => {};
function sample(stage) {
  console.log(JSON.stringify({ stage, ...Object.fromEntries(Object.entries(process.memoryUsage())
    .map(([key, bytes]) => [key, Math.round(bytes / 1048576 * 10) / 10])) }));
}
sample('initialized-MiB');
for (let round = 0; round < rounds; round++) {
  for (const [id, source] of [
    ['latin', '= Hello\n\nA short note with $x^2 + y^2 = 1$.'],
    ['cjk', '#set text(font: ("Georgia", "Source Han Serif SC"))\n= 中文笔记\n\n测试文字与公式 $x^2 + y^2 = 1$.'],
    ['repeat', '= Hello again\n\nA second short note.'],
  ]) {
    const result = await compileTypstVector(compiler, '/workspace/probe.typ', `${source}\n\nRevision ${round}`,
      { queryAnchors: true, inputs: { theme: 'light' } });
    if (!result.artifact) throw new Error(JSON.stringify({ id, diagnostics: result.diagnostics }));
  }
  if ((round + 1) % 250 === 0) sample(`round-${round + 1}-MiB`);
}
globalThis.gc?.();
sample('after-js-gc-MiB');
evict(0);
compiler.resetShadow();
globalThis.gc?.();
sample('after-full-eviction-and-js-gc-MiB');
