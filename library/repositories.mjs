import { validateBookmark } from './bookmark-model.mjs';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { folderName } from './repo-url.mjs';

const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;
const reservedSlugs = new Set(['api', 'assets']);
function checkSlug(slug) {
  if (reservedSlugs.has(slug.toLowerCase())) throw new Error(`Repository folder name is reserved: ${slug}`);
}

export async function openRepositories(dataDirectory) {
  await mkdir(dataDirectory, { recursive: true });
  const file = resolve(dataDirectory, 'repos.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, repos: [] };
  }
  if (state.version !== 1 || !Array.isArray(state.repos) || state.repos.some(repo =>
    typeof repo.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(repo.id) || typeof repo.root !== 'string' ||
    typeof repo.name !== 'string') || new Set(state.repos.map(repo => repo.id)).size !== state.repos.length)
    throw new Error('Invalid or unsupported data/repos.json');
  let pending = Promise.resolve();
  async function save(next) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
    await rename(temporary, file);
    state = next;
  }
  function enqueue(work) {
    const operation = pending.then(work);
    pending = operation.catch(() => {});
    return operation;
  }
  const usedSlugs = new Set();
  for (const repo of state.repos) {
    const slug = folderName(repo.root);
    checkSlug(slug);
    if (usedSlugs.has(pathKey(slug))) throw new Error(`Repository folder name already registered: ${slug}`);
    usedSlugs.add(pathKey(slug));
  }
  if (state.repos.some(repo => repo.slug !== folderName(repo.root))) {
    await save({ ...state, repos: state.repos.map(repo => ({ ...repo, slug: folderName(repo.root) })) });
  }
  return {
    list: () => state.repos.map(repo => ({ ...repo })).sort((a, b) =>
      (b.lastUsedAt || b.createdAt || '').localeCompare(a.lastUsedAt || a.createdAt || '') || a.name.localeCompare(b.name)),
    get: id => state.repos.find(repo => repo.id === id),
    find: value => state.repos.find(repo => pathKey(repo.slug) === pathKey(value))
      || state.repos.find(repo => repo.id === value),
    bookmarks(id) {
      const repo = state.repos.find(repo => repo.id === id);
      if (!repo) throw new Error('Repo not found');
      return (repo.bookmarks || []).map(item => ({ ...item }));
    },
    setBookmark(id, path, bookmarked) {
      return enqueue(async () => {
        validateBookmark(path, bookmarked);
        const repo = state.repos.find(repo => repo.id === id);
        if (!repo) throw new Error('Repo not found');
        const samePath = value => pathKey(value) === pathKey(path);
        const bookmarks = (repo.bookmarks || []).filter(item => !samePath(item.path));
        if (bookmarked) bookmarks.push({ path, updatedAt: new Date().toISOString() });
        await save({ ...state, repos: state.repos.map(item => item.id === id ? { ...item, bookmarks } : item) });
        return bookmarks.map(item => ({ ...item }));
      });
    },
    touch(id) {
      return enqueue(async () => {
        const repo = state.repos.find(repo => repo.id === id);
        if (!repo) return null;
        const updated = { ...repo, lastUsedAt: new Date().toISOString() };
        await save({ ...state, repos: state.repos.map(item => item.id === id ? updated : item) });
        return { ...updated };
      });
    },
    add(root, name) {
      return enqueue(async () => {
        if (typeof root !== 'string' || !root.trim()) throw new Error('A directory path is required');
        if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw new Error('Invalid repo name');
        const canonical = await realpath(resolve(root));
        if (!(await stat(canonical)).isDirectory()) throw new Error('Repo root must be a directory');
        const existing = state.repos.find(repo => pathKey(repo.root) === pathKey(canonical));
        if (existing) return { ...existing };
        const slug = folderName(canonical);
        checkSlug(slug);
        if (state.repos.some(repo => pathKey(repo.slug) === pathKey(slug)))
          throw new Error(`Repository folder name already registered: ${slug}`);
        const repo = { id: randomUUID(), slug, name: name?.trim() || basename(canonical) || canonical,
          root: canonical, createdAt: new Date().toISOString() };
        const next = { version: 1, repos: [...state.repos, repo] };
        await save(next);
        return { ...repo };
      });
    },
  };
}
