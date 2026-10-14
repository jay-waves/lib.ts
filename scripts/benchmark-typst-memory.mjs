// Isolated production-worker probe. Run: node scripts/benchmark-typst-memory.mjs [file.typ]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTypstWorker } from '../server/typst/worker-client.mjs';

process.env.TYPST_WASM_MEMORY = '1';
const mib = value => Math.round(value / 1048576 * 10) / 10;
const rounds = Number(process.env.PROBE_ROUNDS || 1);
const switchFiles = process.env.PROBE_SWITCH_FILES === '1';
const restartEvery = Number(process.env.PROBE_RESTART_EVERY || 0);
let peak = 0, childRss = 0;
function sample(stage) {
  const rss = process.memoryUsage.rss() + childRss;
  peak = Math.max(peak, rss);
  console.log(JSON.stringify({ stage, totalRssMiB: mib(rss), parentRssMiB: mib(process.memoryUsage.rss()), childRssMiB: mib(childRss) }));
}
const file = resolve(process.argv[2] || 'tests/fixtures/memory-probe.typ');
const cases = process.argv[2]
  ? [['file', await readFile(file, 'utf8')]]
  : [
    ['latin', '= Hello\n\nA short note with $x^2 + y^2 = 1$.'],
    ['cjk', '#set text(font: ("Georgia", "Source Han Serif SC"))\n= 中文笔记\n\n测试文字与公式 $x^2 + y^2 = 1$.'],
    ['repeat', '= Hello again\n\nA second short note.'],
  ];
sample('baseline');
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss() + childRss); }, 10);
const worker = createTypstWorker({ root: process.cwd(),
  onStop: () => { childRss = 0; },
  emit: value => {
    if (value.event === 'memory') childRss = value.rssMiB * 1048576;
    if (rounds === 1) console.log(JSON.stringify(value));
  }, profile: stage => { if (rounds === 1) sample(stage); } });
try {
  for (let round = 0; round < rounds; round++) {
  for (const [id, source] of cases) {
    const result = await worker.request('compile', { id,
      file: switchFiles ? resolve(`tests/fixtures/probe-${round}-${id}.typ`) : file,
      source: `${source}\n\nRevision ${round}`, theme: 'light' });
    if (rounds === 1) console.log(JSON.stringify({ id, pages: result.info.length,
      artifactBytes: result.artifactBytes, diagnostics: result.diagnostics }));
    if (result.diagnostics.some(item => item.severity === 'error')) throw new Error('Probe compilation failed');
    if (result.info.length && process.env.PROBE_SKIP_PAGE !== '1') await worker.request('page', { id, page: 1 });
    if (rounds === 1) sample(id);
  }
  if ((round + 1) % 250 === 0 || round + 1 === rounds) sample(`round-${round + 1}`);
  if (restartEvery && (round + 1) % restartEvery === 0 && round + 1 < rounds) {
    await worker.stop();
    sample(`recycled-${round + 1}`);
  }
  }
  await worker.request('retain', []);
  sample('artifacts-cleared');
} finally {
  await worker.stop();
  clearInterval(timer);
  sample('worker-stopped');
  console.log(JSON.stringify({ peakRssMiB: mib(peak), samplingIntervalMs: 10 }));
}
