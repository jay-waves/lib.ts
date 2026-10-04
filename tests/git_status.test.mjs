import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitStatus, parseGitStatus } from '../library/git-status.mjs';

const run = promisify(execFile);

test('Git status preserves spaced paths, rename sources, conflicts and detached HEAD', () => {
  const result = parseGitStatus([
    '# branch.oid abcdef1234567', '# branch.head (detached)',
    '1 .M N... 100644 100644 100644 abc def docs/a file.md',
    '2 R. N... 100644 100644 100644 abc def R100 docs/new name.md', 'docs/old name.md',
    'u UU N... 100644 100644 100644 100644 abc def ghi docs/conflict.md',
    '? docs/new file.md', '? outside.md', '',
  ].join('\0'), 'docs/');
  assert.equal(result.branch, 'Detached HEAD · abcdef1');
  assert.deepEqual(result.changes, [
    { path: 'a file.md', status: '.M' },
    { path: 'new name.md', status: 'R.', originalPath: 'old name.md' },
    { path: 'conflict.md', status: 'UU' },
    { path: 'new file.md', status: '??' },
  ]);
});

test('Git status handles non-repositories and limits paths to the library root', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'library-git-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  assert.equal((await gitStatus(temporary)).repository, false);
  const git = args => run('git', args, { cwd: temporary, windowsHide: true });
  await git(['init', '--initial-branch=main']);
  await mkdir(resolve(temporary, 'docs'));
  await writeFile(resolve(temporary, 'outside.md'), 'outside');
  await writeFile(resolve(temporary, 'docs', 'a file.md'), 'first');
  await git(['add', '--', 'docs/a file.md']);
  await writeFile(resolve(temporary, 'docs', 'a file.md'), 'modified');
  await writeFile(resolve(temporary, 'docs', 'new file.md'), 'new');
  const result = await gitStatus(resolve(temporary, 'docs'));
  assert.equal(result.branch, 'main');
  assert.deepEqual(result.changes, [
    { path: 'a file.md', status: 'AM' },
    { path: 'new file.md', status: '??' },
  ]);
  await writeFile(resolve(temporary, 'docs', 'later.md'), 'later');
  const refreshed = await gitStatus(resolve(temporary, 'docs', '.'));
  assert.ok(refreshed.changes.some(change => change.path === 'later.md'));
  // A failed status must discard the cached subdirectory prefix.
  await rm(resolve(temporary, '.git'), { recursive: true, force: true });
  assert.equal((await gitStatus(resolve(temporary, 'docs'))).repository, false);
  await run('git', ['init', '--initial-branch=main'], { cwd: resolve(temporary, 'docs'), windowsHide: true });
  const relocated = await gitStatus(resolve(temporary, 'docs'));
  assert.ok(relocated.changes.some(change => change.path === 'later.md'));
});
