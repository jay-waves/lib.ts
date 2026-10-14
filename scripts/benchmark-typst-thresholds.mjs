// Sequential fresh-process trials: node scripts/benchmark-typst-thresholds.mjs
import { fork } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTypstWorker } from '../server/typst/worker-client.mjs';

const out = resolve('reports/typst-thresholds');
const thresholds = [256, 512, 1024, 2048, Number.MAX_SAFE_INTEGER];
const counts = { short: 4096, note: 2048 };
const repetitions = Number(process.env.PROBE_REPEATS || 2);

if (process.argv[2] !== 'case') {
  await mkdir(out, { recursive: true });
  const results = [];
  for (const corpus of Object.keys(counts)) for (const threshold of thresholds) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const result = await new Promise((done, fail) => {
      const child = fork(new URL(import.meta.url), ['case', String(threshold), corpus, String(repetition)], {
        execArgv: [], windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let value;
      child.on('message', message => { value = message; });
      child.on('error', fail);
      child.on('exit', code => code === 0 && value ? done(value) : fail(new Error('Trial exited: ' + code)));
    });
    results.push(result);
    await writeFile(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, samples: undefined }));
  }
} else {
  process.env.TYPST_MEMORY = '1';
  const threshold = Number(process.argv[3]), corpus = process.argv[4], repetition = Number(process.argv[5]);
  const count = Number(process.env.PROBE_COUNT || counts[corpus]);
  const short = [
    '= Hello\n\nA short note with $x^2 + y^2 = 1$.',
    '#set text(font: ("Georgia", "Source Han Serif SC"))\n= 中文笔记\n\n测试文字与公式 $x^2 + y^2 = 1$.',
    '= Hello again\n\nA second short note.',
  ];
  const note = '#set text(font: ("Georgia", "Source Han Serif SC"))\n' +
    Array.from({ length: 35 }, (_, i) => '= Section ' + i + '\n\n' +
      'A paragraph about incremental compilation and memory. 中文笔记与阅读定位。\n\n' +
      'A second paragraph describes the document and its references.\n\n' +
      '$ x^2 + y^2 = 1 quad integral_0^1 x^2 dif x $\n\n' +
      '```typ\n#let value = 42\n```\n\n').join('');
  const file = resolve('tests/fixtures/memory-threshold.typ');
  let childRss = 0, peak = 0, starts = 0;
  const samples = [], times = [], coldTimes = [], warmTimes = [];
  function memory() {
    const total = process.memoryUsage.rss() / 1048576 + childRss;
    peak = Math.max(peak, total);
    return Math.round(total * 10) / 10;
  }
  const worker = createTypstWorker({ root: process.cwd(), maxCompilations: threshold,
    onStop: () => { childRss = 0; },
    emit: value => { if (value.event === 'memory') { childRss = value.rssMiB; memory(); } },
    profile: stage => { if (stage === 'Typst worker start') starts++; },
  });
  const timer = setInterval(memory, 10);
  const started = performance.now();
  try {
    for (let i = 0; i < count; i++) {
      const before = starts, clock = performance.now();
      const source = (corpus === 'short' ? short[i % short.length] : note) + '\n\nRevision ' + i;
      const result = await worker.request('compile', { id: String(i % 3), file, source, theme: 'light' });
      if (result.diagnostics.some(item => item.severity === 'error')) throw new Error(JSON.stringify(result.diagnostics));
      const elapsed = performance.now() - clock;
      times.push(elapsed); (starts > before ? coldTimes : warmTimes).push(elapsed);
      await worker.request('page', { id: String(i % 3), page: 1 });
      if ((i + 1) % 64 === 0 || i + 1 === count) samples.push({ compilations: i + 1, totalRssMiB: memory() });
    }
  } finally { await worker.stop(); clearInterval(timer); }
  const quantile = (values, q) => {
    const sorted = [...values].sort((a,b) => a-b);
    return Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] || 0) * 100) / 100;
  };
  const result = { corpus, repetition, threshold: threshold === Number.MAX_SAFE_INTEGER ? 'none' : threshold,
    compilations: count, sourceLines: (corpus === 'short' ? short[1] : note).split('\n').length,
    starts, elapsedSeconds: Math.round((performance.now() - started) / 10) / 100,
    peakTotalRssMiB: Math.round(peak * 10) / 10,
    compileMedianMs: quantile(times, .5), compileP95Ms: quantile(times, .95),
    compileP99Ms: quantile(times, .99), warmMedianMs: quantile(warmTimes, .5),
    coldMedianMs: quantile(coldTimes, .5), coldMaxMs: quantile(coldTimes, 1),
    samples };
  process.send(result);
  process.disconnect();
}
