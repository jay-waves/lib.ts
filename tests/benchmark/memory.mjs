import { fork } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { discoverTypstFonts } from '../../server/typst/fonts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
const allowed = new Set(['--full', '--baseline', '--save-baseline', '--output']);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
  const key = args[i];
  options[key] = key === '--full' ? true : args[++i];
  if (!options[key] || (key !== '--full' && options[key].startsWith('--')))
    throw new Error(`Missing value for ${key}`);
}
const config = { version: 1, compilations: options['--full'] ? 2048 : 1024,
  repetitions: options['--full'] ? 5 : 3, scenarios: ['edit', 'switch'],
  peakBudgetMiB: 768, cycleGrowthBudgetMiB: 64, relativeTolerance: .15, absoluteToleranceMiB: 32 };
const fontHash = createHash('sha256');
for (const font of discoverTypstFonts()) fontHash.update(await readFile(font));
const environment = { platform: process.platform, arch: process.arch, node: process.version,
  os: release(), cpu: cpus()[0]?.model,
  fontsSha256: fontHash.digest('hex'),
  lockSha256: createHash('sha256').update(await readFile('package-lock.json')).digest('hex') };
let baseline;
if (options['--baseline']) {
  baseline = JSON.parse(await readFile(resolve(options['--baseline']), 'utf8'));
  if (JSON.stringify(baseline.config) !== JSON.stringify(config) ||
      JSON.stringify(baseline.environment) !== JSON.stringify(environment))
    throw new Error('Baseline environment/config mismatch; collect a baseline on this runner with the same profile.');
}
const trials = [], failures = [];
for (const scenario of config.scenarios) {
  for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    console.log(`${scenario}: trial ${repetition}/${config.repetitions}`);
    const result = await new Promise((done, fail) => {
      const child = fork(new URL('./typst-case.mjs', import.meta.url),
        [JSON.stringify({ scenario, compilations: config.compilations })],
        { cwd: root, execArgv: [], windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      let result;
      const timer = setTimeout(() => { child.kill(); fail(new Error('Benchmark trial timed out (10 minutes)')); }, 600000);
      child.on('message', value => { result = value; });
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !result) fail(new Error(`Benchmark trial failed: ${code}`));
        else done(result);
      });
    });
    trials.push({ repetition, ...result });
    if (result.starts !== Math.ceil(config.compilations / 256)) failures.push(`${scenario}/${repetition}: unexpected worker start count`);
    if (result.metrics.peakTotalRssMiB > config.peakBudgetMiB) failures.push(`${scenario}/${repetition}: RSS exceeds ${config.peakBudgetMiB} MiB`);
    if (result.metrics.cyclePeakGrowthMiB > config.cycleGrowthBudgetMiB) failures.push(`${scenario}/${repetition}: cycle peak growth exceeds ${config.cycleGrowthBudgetMiB} MiB`);
  }
}
const summary = Object.fromEntries(config.scenarios.map(scenario => {
  const rows = trials.filter(row => row.scenario === scenario);
  return [scenario, Object.fromEntries(Object.keys(rows[0].metrics).map(key => {
    const values = rows.map(row => row.metrics[key]).sort((a, b) => a - b);
    return [key, values[Math.floor(values.length / 2)]];
  }))];
}));
if (baseline) for (const scenario of config.scenarios) {
  for (const metric of ['peakTotalRssMiB', 'coldTotalRssMiB', 'stoppedParentRssMiB']) {
    const previous = baseline.summary?.[scenario]?.[metric];
    if (!Number.isFinite(previous)) throw new Error(`Invalid baseline metric: ${scenario}.${metric}`);
    const delta = summary[scenario][metric] - previous;
    if (delta > config.absoluteToleranceMiB && delta > previous * config.relativeTolerance)
      failures.push(`${scenario}.${metric}: ${previous.toFixed(1)} -> ${summary[scenario][metric].toFixed(1)} MiB`);
  }
}
const report = { date: new Date().toISOString(), environment, config, summary, trials, failures };
async function save(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + '\n');
}
await save(resolve(options['--output'] || 'reports/benchmark-memory/latest.json'));
if (options['--save-baseline'] && !failures.length) await save(resolve(options['--save-baseline']));
console.log(JSON.stringify({ summary, failures }, null, 2));
if (failures.length) process.exitCode = 1;
