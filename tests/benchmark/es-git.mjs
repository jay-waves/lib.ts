// Optional dependency: npm install --no-save --package-lock=false es-git@0.7.0
// Run: node tests/benchmark/es-git.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { gitStatus } from '../../server/git-status.mjs';

const run = promisify(execFile);
const started = performance.now();
const { openRepository } = await import('es-git');
const importMs = performance.now() - started;
const temporary = await mkdtemp(resolve(tmpdir(), 'es-git-validation-'));
const git = args => run('git', args, { cwd: temporary, windowsHide: true,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
const entries = repo => [...repo.statuses().iter()].map(entry => ({
  path: entry.path(), status: entry.status(),
  oldPath: entry.headToIndex()?.oldFile().path(),
  newPath: entry.headToIndex()?.newFile().path(),
}));
async function measure(work, iterations = 10) {
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  return { firstMs: samples[0], medianMs: samples.slice(1).sort((a, b) => a - b)[Math.floor((samples.length - 1) / 2)] };
}
try {
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Validation']);
  await git(['config', 'user.email', 'validation@example.com']);
  await git(['config', 'core.autocrlf', 'false']);
  await mkdir(resolve(temporary, 'docs'));
  await writeFile(resolve(temporary, '.gitignore'), 'ignored/\n');
  await writeFile(resolve(temporary, 'docs/both.md'), 'original\n');
  await writeFile(resolve(temporary, 'docs/old name.md'), 'rename\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'fixture']);
  await writeFile(resolve(temporary, 'docs/both.md'), 'staged\n');
  await rename(resolve(temporary, 'docs/old name.md'), resolve(temporary, 'docs/new name.md'));
  await git(['add', '.']);
  await writeFile(resolve(temporary, 'docs/both.md'), 'unstaged\n');
  await mkdir(resolve(temporary, 'docs/new folder'));
  await writeFile(resolve(temporary, 'docs/new folder/new.md'), 'new\n');
  await mkdir(resolve(temporary, 'ignored'));
  await writeFile(resolve(temporary, 'ignored/private.txt'), 'ignored\n');
  const repo = await openRepository(temporary);
  const before = await readFile(resolve(temporary, '.git/index'));
  const cli = await gitStatus(temporary);
  const native = entries(repo);
  const optionsAttempt = [...repo.statuses({ recurseUntrackedDirs: true, includeIgnored: false }).iter()]
    .map(entry => entry.path());
  assert.ok(cli.changes.some(change => change.path === 'docs/new folder/new.md'));
  const unstaged = repo.diffIndexToWorkdir(null, { pathspecs: ['docs/both.md'], disablePathspecMatch: true }).print();
  const { stdout: cliPatch } = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--', 'docs/both.md']);
  assert.match(cliPatch, /-staged\n\+unstaged/);
  assert.deepEqual(await readFile(resolve(temporary, '.git/index')), before);
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
  const small = { cli: await measure(() => gitStatus(temporary)), native: await measure(() => entries(repo)) };

  // A bounded fixture for status traversal, not a production-workload forecast.
  await mkdir(resolve(temporary, 'notes'));
  for (let offset = 0; offset < 3000; offset += 50) {
    await Promise.all(Array.from({ length: 50 }, (_, index) =>
      writeFile(resolve(temporary, `notes/note-${offset + index}.md`), '# Note\ncontent\n')));
  }
  await git(['add', 'notes']);
  await git(['commit', '-m', 'notes']);
  const largeRepo = await openRepository(temporary);
  const large = { cli: await measure(() => gitStatus(temporary)), native: await measure(() => entries(largeRepo)) };
  const delayStarted = performance.now();
  const delay = new Promise(done => setImmediate(() => done(performance.now() - delayStarted)));
  for (let index = 0; index < 10; index++) entries(largeRepo);
  const timerDelayMs = await delay;
  const cliStarted = performance.now();
  const cliDelay = new Promise(done => setImmediate(() => done(performance.now() - cliStarted)));
  await Promise.all([gitStatus(temporary), cliDelay]);
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, importMs,
    findings: {
      missingTreeToIndex: !methods.includes('diffTreeToIndex'),
      nativeUntrackedPaths: native.filter(entry => entry.status.wtNew).map(entry => entry.path),
      cliUntrackedPaths: cli.changes.filter(change => change.status === '??').map(change => change.path),
      ignoredIncluded: native.some(entry => entry.status.ignored),
      optionsAttempt,
      rename: native.filter(entry => entry.status.indexRenamed),
      nativePatch: unstaged, cliPatch,
      patchHasLineMarkers: /-staged\n\+unstaged/.test(unstaged), indexUnchanged: true,
    }, small, tracked3000: large,
    eventLoop: { tenNativeScansDelayMs: timerDelayMs, oneCliScanDelayMs: await cliDelay },
  }, null, 2));
} finally {
  const rel = relative(resolve(tmpdir()), temporary);
  assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../'));
  await rm(temporary, { recursive: true, force: true });
}
