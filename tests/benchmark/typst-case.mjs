import { resolve } from 'node:path';
import { createTypstWorker } from '../../server/typst/worker-client.mjs';

process.env.TYPST_MEMORY = '1';
const config = JSON.parse(process.argv[2]);
const mib = bytes => bytes / 1048576;
const baselineRssMiB = mib(process.memoryUsage.rss());
let childRss = 0, peak = baselineRssMiB, starts = 0;
const cycles = [], samples = [], warm = [], restarts = [];
const sample = () => {
  const parentRssMiB = mib(process.memoryUsage.rss());
  const totalRssMiB = parentRssMiB + childRss;
  peak = Math.max(peak, totalRssMiB);
  if (starts) cycles[starts - 1] = Math.max(cycles[starts - 1] || 0, totalRssMiB);
  return { parentRssMiB, childRssMiB: childRss, totalRssMiB };
};
const worker = createTypstWorker({ root: process.cwd(),
  onStop() { childRss = 0; },
  emit(value) { if (value.event === 'memory') { childRss = value.rssMiB; sample(); } },
  profile(stage) { if (stage === 'Typst worker start') starts++; },
});
const timer = setInterval(sample, 10);
const source = '#set text(font: "Source Han Serif SC")\n' +
  Array.from({ length: config.scenario === 'switch' ? 12 : 2 }, (_, i) =>
    `= Section ${i}\n\nHello 中文笔记 $x^2 + y^2 = 1$.\n\n`).join('');
let coldCompileMs, coldPageMs, coldReadyMs, coldMemory;
try {
  for (let i = 0; i < config.compilations; i++) {
    const id = config.scenario === 'switch' ? String(i % 8) : 'note';
    const before = starts, clock = performance.now();
    const result = await worker.request('compile', { id,
      file: resolve(`tests/benchmark/document-${id}.typ`), source: source + `\nRevision ${i}`,
      theme: i % 2 ? 'dark' : 'light' });
    const compileMs = performance.now() - clock;
    if (!result.info.length || result.diagnostics.some(item => item.severity === 'error'))
      throw new Error(JSON.stringify(result.diagnostics));
    const pageClock = performance.now();
    const page = await worker.request('page', { id, page: 1 });
    if (!page.svg?.includes('<svg')) throw new Error('Missing rendered page');
    if (i === 0) {
      coldCompileMs = compileMs;
      coldPageMs = performance.now() - pageClock;
      coldReadyMs = performance.now() - clock;
      coldMemory = sample();
    } else if (starts > before) restarts.push(performance.now() - clock);
    else if (i % 256 >= 8) warm.push(compileMs);
    if ((i + 1) % 64 === 0 || i + 1 === config.compilations)
      samples.push({ compilations: i + 1, cycle: starts, ...sample() });
  }
  await worker.request('retain', []);
  const cleared = sample();
  await worker.stop();
  const stopped = sample();
  const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] || 0;
  process.send({ scenario: config.scenario, metrics: {
    baselineRssMiB, peakTotalRssMiB: peak, coldCompileMs, coldPageMs, coldReadyMs,
    coldTotalRssMiB: coldMemory.totalRssMiB,
    warmCompileMedianMs: quantile(warm, .5), warmCompileP95Ms: quantile(warm, .95),
    restartReadyMedianMs: quantile(restarts, .5),
    cyclePeakGrowthMiB: Math.max(0, cycles.at(-1) - cycles[0]),
    stoppedParentRssMiB: stopped.parentRssMiB,
  }, starts, coldMemory, cleared, stopped, cyclePeaksMiB: cycles, samples });
} finally {
  clearInterval(timer);
  await worker.stop();
  process.disconnect?.();
}
