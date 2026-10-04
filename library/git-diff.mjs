import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { sharedGitStatus } from './git-cache.mjs';
import { isGitConflict } from './git-changes.mjs';

const run = promisify(execFile);
const maxBytes = 2 * 1024 * 1024;

export function parseGitDiff(patch) {
  const hunks = [];
  const metadata = [];
  let hunk, oldLine = 0, newLine = 0, additions = 0, deletions = 0;
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[3]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +\-\\]/.test(line)) {
      const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'delete' : line[0] === ' ' ? 'context' : 'note';
      if (kind === 'add') additions++;
      if (kind === 'delete') deletions++;
      hunk.lines.push({ kind, text: line.slice(1),
        oldLine: kind === 'context' || kind === 'delete' ? oldLine++ : null,
        newLine: kind === 'context' || kind === 'add' ? newLine++ : null });
    } else {
      hunk = null;
      if (/^(old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to|Submodule|\* Unmerged)/.test(line)) metadata.push(line);
    }
  }
  return { hunks, additions, deletions, metadata, binary: /^(Binary files .* differ|GIT binary patch)$/m.test(patch) };
}

async function untrackedDiff(root, path) {
  const file = resolve(root, path);
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Invalid file path');
  const info = await lstat(file);
  if (info.size > maxBytes) return { tooLarge: true, hunks: [], additions: 0, deletions: 0, metadata: [] };
  const buffer = info.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
  if (buffer.includes(0)) return { binary: true, hunks: [], additions: 0, deletions: 0, metadata: [] };
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { additions: lines.length, deletions: 0, metadata: [], hunks: lines.length ? [{
    header: `@@ -0,0 +1,${lines.length} @@`,
    lines: lines.map((text, index) => ({ kind: 'add', text, oldLine: null, newLine: index + 1 })),
  }] : [] };
}

export async function gitDiff(root, path, signal, scope = 'all') {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('Invalid file path');
  if (!['all', 'staged', 'unstaged', 'conflict'].includes(scope)) throw new Error('Invalid diff scope');
  const status = await sharedGitStatus(root);
  const change = status.changes.find(change => change.path === path);
  if (!change) return { path, sections: [], clean: true };
  if (change.status === '??') return scope === 'all' || scope === 'unstaged'
    ? { path, sections: [{ id: 'untracked', label: 'Untracked', ...await untrackedDiff(root, path) }] }
    : { path, sections: [], clean: true };
  const sections = [];
  const conflict = isGitConflict(change.status);
  const paths = [path];
  if (change.originalPath) paths.push(change.originalPath);
  for (const [id, label, flags, enabled] of [
    ['staged', 'Staged changes', ['--cached'], !conflict && change.status[0] !== '.'],
    ['unstaged', conflict ? 'Conflict · compared with ours' : 'Unstaged changes', conflict ? ['--ours'] : [], conflict || change.status[1] !== '.'],
  ]) {
    if (!enabled || (scope !== 'all' && scope !== (conflict ? 'conflict' : id))) continue;
    try {
      const { stdout } = await run('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3',
        '--submodule=short', ...flags, '--', ...paths.map(path => `:(literal)${path}`)], {
        cwd: root, windowsHide: true, timeout: 10000, maxBuffer: maxBytes, signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      });
      sections.push({ id, label, ...parseGitDiff(stdout) });
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') sections.push({ id, label, tooLarge: true, hunks: [], metadata: [], additions: 0, deletions: 0 });
      else throw error;
    }
  }
  return { path, originalPath: change.originalPath, conflict, sections, clean: sections.length === 0 };
}
