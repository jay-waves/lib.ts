import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const prefixes = new Map();
const maxCachedRoots = 256;

async function gitPrefix(root, options) {
  if (prefixes.has(root)) return prefixes.get(root);
  const { stdout } = await run('git', ['rev-parse', '--show-prefix'], options);
  // Preserve spaces in directory names; remove only Git's line terminator.
  const prefix = stdout.replace(/\r?\n$/, '');
  if (prefixes.size >= maxCachedRoots) prefixes.delete(prefixes.keys().next().value);
  prefixes.set(root, prefix);
  return prefix;
}

export function parseGitStatus(output, prefix = '') {
  let branch = '', commit = '', detached = false;
  const changes = [], records = output.split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith('# branch.head ')) {
      branch = record.slice(14);
      detached = branch === '(detached)';
    } else if (record.startsWith('# branch.oid ') && record.slice(13) !== '(initial)') {
      // Keep the abbreviated commit available for detached HEADs.
      commit = record.slice(13, 20);
    } else if (/^[12u?] /.test(record)) {
      const kind = record[0], fields = record.split(' ');
      const path = kind === '?' ? record.slice(2) : fields.slice(kind === '1' ? 8 : kind === '2' ? 9 : 10).join(' ');
      const originalPath = kind === '2' ? records[++index] : null;
      if (prefix && !path.startsWith(prefix)) continue;
      changes.push({ path: path.slice(prefix.length), status: kind === '?' ? '??' : fields[1],
        ...(originalPath ? { originalPath: originalPath.startsWith(prefix) ? originalPath.slice(prefix.length) : originalPath } : {}) });
    }
  }
  return { repository: true, branch: detached ? `Detached HEAD · ${commit || ''}`.trim() : branch, changes };
}

export async function gitStatus(root, signal) {
  root = resolve(root);
  const options = { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } };
  try {
    const prefix = await gitPrefix(root, options);
    const { stdout } = await run('git', ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.'], options);
    return parseGitStatus(stdout, prefix);
  } catch (error) {
    // Cancellation belongs to this request; other failures invalidate discovery.
    if (error.name !== 'AbortError') prefixes.delete(root);
    if (/not a git repository/i.test(error.stderr || '')) return { repository: false, branch: '', changes: [] };
    if (error.code === 'ENOENT') throw new Error('Git is not installed or is not available on PATH.');
    if (error.name === 'AbortError') throw error;
    throw new Error('Could not read Git status. Check repository access and try again.');
  }
}
