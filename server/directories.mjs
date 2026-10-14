import { readdir, realpath, stat, access } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute } from 'node:path';

export async function browseDirectories(path, { initialRoot, dataDirectory }) {
  const root = await realpath(resolve(path || initialRoot));
  if (dataDirectory) dataDirectory = await realpath(dataDirectory);
  const privatePath = file => {
    if (!dataDirectory) return false;
    const rel = relative(dataDirectory, file);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
  };
  if (privatePath(root)) throw new Error('Application data is private');
  if (!(await stat(root)).isDirectory()) throw new Error('Not a directory');
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') &&
    entry.name !== 'node_modules' && !privatePath(resolve(root, entry.name)))
    .map(entry => ({ name: entry.name, path: resolve(root, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const drives = process.platform === 'win32' ? (await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const path = `${String.fromCharCode(65 + index)}:/`;
    try { await access(path); return { name: path, path }; } catch { return null; }
  }))).filter(Boolean) : [{ name: '/', path: '/' }];
  return { path: root, name: basename(root) || root, parent: dirname(root) === root ? null : dirname(root), directories, drives };
}
