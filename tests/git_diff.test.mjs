import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitDiff, parseGitDiff } from '../library/git-diff.mjs';
import { sharedGitStatus } from '../library/git-cache.mjs';

const run = promisify(execFile);
async function repository(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'library-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => run('git', args, { cwd: root, windowsHide: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'core.autocrlf', 'false']);
  return { root, git };
}

test('unified diff parses line numbers, no-newline markers and multiple hunks', () => {
  const result = parseGitDiff('--- a/file\n+++ b/file\n@@ -2,2 +2,2 @@ title\n same\n-old\n+new\n\\ No newline at end of file\n@@ -20 +20 @@\n-x\n+y\n');
  assert.equal(result.additions, 2);
  assert.equal(result.deletions, 2);
  assert.deepEqual(result.hunks[0].lines.map(line => [line.kind, line.oldLine, line.newLine]),
    [['context', 2, 2], ['delete', 3, null], ['add', null, 3], ['note', null, null]]);
  assert.equal(result.hunks[1].lines[1].newLine, 20);
});

test('diff supports staged and unstaged edits, deleted files, renames, binary and untracked files', async t => {
  const { root, git } = await repository(t);
  await mkdir(resolve(root, 'docs'));
  for (const name of ['both.md', 'delete.md', 'old name.md']) await writeFile(resolve(root, 'docs', name), 'original\n');
  await writeFile(resolve(root, 'docs', 'binary.bin'), Buffer.from([0, 1, 2]));
  await git(['add', '.']); await git(['commit', '-m', 'initial']);
  await writeFile(resolve(root, 'docs', 'both.md'), 'staged\n');
  await git(['add', 'docs/both.md']);
  await writeFile(resolve(root, 'docs', 'both.md'), 'unstaged\n');
  await rm(resolve(root, 'docs', 'delete.md'));
  await rename(resolve(root, 'docs', 'old name.md'), resolve(root, 'docs', 'new name.md'));
  await git(['add', '--', 'docs/old name.md', 'docs/new name.md']);
  await writeFile(resolve(root, 'docs', 'binary.bin'), Buffer.from([0, 4, 5]));
  await mkdir(resolve(root, 'docs', 'new folder'));
  await writeFile(resolve(root, 'docs', 'new folder', 'new.md'), 'new\nfile\n');
  const dir = resolve(root, 'docs');
  const both = await gitDiff(dir, 'both.md');
  assert.deepEqual(both.sections.map(section => section.id), ['staged', 'unstaged']);
  assert.equal(both.sections[0].hunks[0].lines.find(line => line.kind === 'add').text, 'staged');
  assert.equal(both.sections[1].hunks[0].lines.find(line => line.kind === 'add').text, 'unstaged');
  assert.deepEqual((await gitDiff(dir, 'both.md', undefined, 'staged')).sections.map(section => section.id), ['staged']);
  assert.deepEqual((await gitDiff(dir, 'both.md', undefined, 'unstaged')).sections.map(section => section.id), ['unstaged']);
  assert.equal((await gitDiff(dir, 'delete.md')).sections[0].deletions, 1);
  const renamed = await gitDiff(dir, 'new name.md');
  assert.equal(renamed.originalPath, 'old name.md');
  assert.ok(renamed.sections[0].metadata.some(line => line.startsWith('rename from')));
  assert.equal((await gitDiff(dir, 'binary.bin')).sections[0].binary, true);
  assert.equal((await gitDiff(dir, 'new folder/new.md')).sections[0].additions, 2);
  assert.equal((await gitDiff(dir, 'new folder/new.md', undefined, 'staged')).clean, true);
  await assert.rejects(gitDiff(dir, 'both.md', undefined, 'invalid'), /Invalid diff scope/);
  assert.equal((await gitDiff(dir, '../outside')).clean, true);
  assert.equal((await gitDiff(dir, ':(glob)*')).clean, true);
  await git(['checkout', '--', 'docs/both.md']);
  await sharedGitStatus(dir, { force: true });
  assert.deepEqual((await gitDiff(dir, 'both.md')).sections.map(section => section.id), ['staged']);
});

test('initial repositories and oversized untracked files have useful diffs', async t => {
  const { root, git } = await repository(t);
  await writeFile(resolve(root, 'first.md'), 'first\n');
  await git(['add', 'first.md']);
  await writeFile(resolve(root, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal((await gitDiff(root, 'first.md')).sections[0].additions, 1);
  assert.equal((await gitDiff(root, 'large.txt')).sections[0].tooLarge, true);
});

test('conflicts produce ordinary line diffs against ours', async t => {
  const { root, git } = await repository(t);
  await writeFile(resolve(root, 'conflict.txt'), 'base\n');
  await git(['add', '.']); await git(['commit', '-m', 'base']);
  await git(['checkout', '-b', 'other']);
  await writeFile(resolve(root, 'conflict.txt'), 'theirs\n');
  await git(['commit', '-am', 'theirs']);
  await git(['checkout', 'main']);
  await writeFile(resolve(root, 'conflict.txt'), 'ours\n');
  await git(['commit', '-am', 'ours']);
  await assert.rejects(git(['merge', 'other']));
  const diff = await gitDiff(root, 'conflict.txt');
  assert.equal(diff.conflict, true);
  assert.ok(diff.sections[0].hunks.length > 0);
  assert.ok(diff.sections[0].hunks[0].lines.some(line => line.text.includes('<<<<<<<')));
});
