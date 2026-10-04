import { resolve } from 'node:path';
import { fileResponse } from '../file-response.mjs';
import { createReadingStore } from './reading-store.mjs';
import { openSystemDirectory } from './system-directory.mjs';
import { stat } from 'node:fs/promises';
import { validateBookmark } from './bookmark-model.mjs';
import { createLibrarySearch } from './search.mjs';
import { createSearchCache } from './search-cache.mjs';
import { searchFileBytes } from './search-core.mjs';
import { randomUUID } from 'node:crypto';
import { browseDirectories } from './directories.mjs';
import { Hono } from 'hono';
import { createLibraryRoutes } from './routes.mjs';
import { repoSegment } from './repo-url.mjs';
import { repositoryUrl, repositoryApiUrl } from './paths.mjs';

export function createRepositoryRoutes({ repositories, defaultRepo, ...options }) {
  const app = new Hono();
  const routes = new Map();
  const describe = repo => {
    const { bookmarks, ...metadata } = repo;
    return { ...metadata, url: repositoryUrl(repo), apiUrl: repositoryApiUrl(repo) };
  };
  function mutationError(context) {
    const origin = context.req.header('origin');
    if (origin && origin !== new URL(context.req.url).origin) return options.json({ error: 'Cross-origin registration is forbidden' }, 403);
    if (!context.req.header('content-type')?.startsWith('application/json')) return options.json({ error: 'Expected application/json' }, 415);
  }
  const bookmarkRepo = context => repositories.find(context.req.param('repoId') || defaultRepo?.id);
  function listBookmarks(context) {
    const repo = bookmarkRepo(context);
    return repo ? options.json({ bookmarks: repositories.bookmarks(repo.id) })
      : options.json({ error: 'Repo not found' }, 404);
  }
  async function setBookmark(context) {
    const error = mutationError(context);
    if (error) return error;
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try {
      const { path, bookmarked } = await context.req.json();
      validateBookmark(path, bookmarked);
      // Removal also works for a file that has since been deleted.
      if (bookmarked && !(await stat(options.checkedPath(path, repo.root))).isFile())
        throw new Error('Only files can be bookmarked.');
      return options.json({ bookmarks: await repositories.setBookmark(repo.id, path, bookmarked) });
    } catch (error) { return options.json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  }
  async function openDirectory(context) {
    const error = mutationError(context);
    if (error) return error;
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try {
      const { path = '' } = await context.req.json();
      if (typeof path !== 'string' || path.includes('\0')) throw new Error('Invalid directory path');
      const directory = options.checkedPath(path || '.', repo.root);
      if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory');
      await (options.openSystemDirectory || openSystemDirectory)(directory);
      return options.json({ ok: true });
    } catch (error) {
      return options.json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400);
    }
  }
  app.post('/:repoId/api/open-directory', openDirectory);
  app.get('/:repoId/api/bookmarks', listBookmarks);
  app.put('/:repoId/api/bookmarks', setBookmark);
  const reading = createReadingStore(options.dataDirectory, {
    onError: error => (options.onReadingError || console.error)(error),
  });
  app.flushReadingState = () => reading.flush();
  app.closeReadingState = () => reading.close();
  const getReading = async context => {
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try { return options.json(await reading.read(repo.id)); }
    catch (error) { return options.json({ error: error.message }, 400); }
  };
  const putReading = async context => {
    const error = mutationError(context);
    if (error) return error;
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try {
      const { positions } = await context.req.json();
      await reading.save(repo.id, positions);
      return options.json({ ok: true });
    } catch (error) { return options.json({ error: error.message }, 400); }
  };
  app.get('/:repoId/api/reading', getReading);
  app.put('/:repoId/api/reading', putReading);
  const getRecent = async context => {
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try { return options.json(await reading.recentHistory(repo.id)); }
    catch (error) { return options.json({ error: error.message }, 400); }
  };
  const changeRecent = async context => {
    const error = mutationError(context);
    if (error) return error;
    const repo = bookmarkRepo(context);
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    try {
      if (context.req.method === 'DELETE') { await reading.clearRecent(repo.id); return options.json(await reading.recentHistory(repo.id)); }
      const { path } = await context.req.json();
      validateBookmark(path, false);
      if (!(await stat(options.checkedPath(path, repo.root))).isFile()) throw new Error('Only files can be recorded.');
      await reading.visit(repo.id, path);
      return options.json(await reading.recentHistory(repo.id));
    } catch (error) { return options.json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  };
  app.get('/:repoId/api/recent-files', getRecent);
  app.post('/:repoId/api/recent-files', changeRecent);
  app.delete('/:repoId/api/recent-files', changeRecent);
  const searches = new Map(), snapshots = createSearchCache({ limit: 8 });
  app.get('/api/search-repos', async context => {
    try {
      const params = new URL(context.req.url).searchParams;
      const scope = params.get('repo') || defaultRepo?.id;
      const selected = scope === '*' ? repositories.list() : [repositories.find(scope)].filter(Boolean);
      if (!selected.length) return options.json({ error: 'Repo not found' }, 404);
      const key = JSON.stringify([params.get('q'), scope, params.get('currentRepo'), params.get('currentFile')]);
      for (const [id, snapshot] of snapshots) if (Date.now() - snapshot.time > 300000) snapshots.delete(id);
      let snapshot = snapshots.get(params.get('searchId'));
      if (params.has('searchId') && (!snapshot || snapshot.key !== key)) throw new Error('Search expired. Run the search again.');
      if (!snapshot) {
        const groups = await Promise.all(selected.map(async repo => {
          if (!searches.has(repo.id)) searches.set(repo.id, createLibrarySearch(repo.root, options.dataDirectory));
          const search = searches.get(repo.id);
          const query = new URLSearchParams({ q: params.get('q') || '', refresh: 'true' });
          let page = await search(query);
          const files = [...page.files];
          while (page.nextOffset !== null) {
            query.set('searchId', page.searchId); query.set('offset', String(page.nextOffset));
            page = await search(query); files.push(...page.files);
          }
          return { facets: page.facets, files: files.map(file => ({ ...file, repoId: repo.id, repoName: repo.name })), truncated: page.truncated };
        }));
        const files = groups.flatMap(group => group.files);
        const currentRepo = repositories.find(params.get('currentRepo') || defaultRepo?.id);
        const preferred = file => file.repoId === currentRepo?.id && file.path === params.get('currentFile');
        files.sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || a.repoName.localeCompare(b.repoName) || a.path.localeCompare(b.path));
        const facets = Object.fromEntries(['languages', 'paths'].map(kind => {
          const counts = new Map();
          for (const group of groups) for (const item of group.facets[kind]) counts.set(item.value, (counts.get(item.value) || 0) + item.count);
          return [kind, [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))];
        }));
        // Aggregated snapshots retain snippets after the source cache evicts them.
        // Charge them to the same global budget, conservatively counting shared data twice.
        const resultBytes = 512 + key.length * 2 + files.reduce((bytes, file) => bytes + searchFileBytes(file)
          + 128 + (file.repoId.length + file.repoName.length + file.language.length) * 2, 0)
          + Object.values(facets).flat().reduce((bytes, facet) => bytes + 128 + facet.value.length * 2, 0);
        snapshot = { facets, key, id: randomUUID(), files, resultBytes, truncated: groups.some(group => group.truncated), time: Date.now() };
        snapshots.set(snapshot.id, snapshot);
      }
      const offset = Math.max(0, Math.floor(Number(params.get('offset'))) || 0);
      const files = snapshot.files.slice(offset, offset + 20);
      return options.json({ searchId: snapshot.id, total: snapshot.files.length, files, truncated: snapshot.truncated,
        matchCount: snapshot.files.reduce((count, file) => count + file.matchCount, 0),
        nextOffset: offset + files.length < snapshot.files.length ? offset + files.length : null,
        facets: snapshot.facets });
    } catch (error) { return options.json({ error: error.message }, 400); }
  });
  app.get('/api/directories', async context => {
    try { return options.json(await browseDirectories(context.req.query('path'), { initialRoot: options.initialRoot || defaultRepo?.root || process.cwd(), dataDirectory: options.dataDirectory })); }
    catch (error) { return options.json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  app.post('/:repoId/api/use', async context => {
    const error = mutationError(context);
    if (error) return error;
    try {
      const selected = repositories.find(context.req.param('repoId'));
      const repo = selected && await repositories.touch(selected.id);
      return repo ? options.json(describe(repo)) : options.json({ error: 'Repo not found' }, 404);
    } catch (error) { return options.json({ error: error.message }, 500); }
  });
  app.get('/api/repos', () => options.json({ repos: repositories.list().map(describe), defaultRepoId: defaultRepo?.id || null }));
  app.post('/api/repos', async context => {
    try {
      const error = mutationError(context);
      if (error) return error;
      const input = await context.req.json();
      const repo = await repositories.add(input.root, input.name);
      return options.json(describe(repo), 201);
    } catch (error) { return options.json({ error: error.message }, 400); }
  });
  app.get('/:repoId/api', context => {
    const repo = repositories.find(context.req.param('repoId'));
    return repo ? options.json(describe(repo)) : options.json({ error: 'Repo not found' }, 404);
  });
  function getRoutes(repo) {
    if (!routes.has(repo.id)) routes.set(repo.id, createLibraryRoutes({ ...options, root: repo.root,
      apiBase: repositoryApiUrl(repo),
      getSearchPaths: async () => repositories.bookmarks(repo.id).map(item => item.path),
      checkedPath: path => options.checkedPath(path, repo.root) }));
    return routes.get(repo.id);
  }
  async function dispatch(context, api) {
    const repo = repositories.find(context.req.param('repoId'));
    if (!repo) return options.json({ error: 'Repo not found' }, 404);
    const url = new URL(context.req.url);
    if (!api) {
      const canonicalPath = url.pathname.replace(/^\/[^/]+/, `/${repoSegment(repo)}`);
      if (canonicalPath !== url.pathname) return context.redirect(`${canonicalPath}${url.search}`, 308);
    }
    url.pathname = api ? url.pathname.replace(/^\/[^/]+\/api/, '/api') : '/';
    return getRoutes(repo).fetch(new Request(url, context.req.raw));
  }
  app.all('/:repoId/api/*', context => dispatch(context, true));
  app.all('/:repoId/tree', context => {
    const repo = repositories.find(context.req.param('repoId'));
    return repo ? context.redirect(`${repositoryUrl(repo)}${new URL(context.req.url).search}`, 308)
      : options.json({ error: 'Repo not found' }, 404);
  });
  app.all('/:repoId/tree/*', context => dispatch(context, false));
  app.get('/:repoId/search', context => dispatch(context, false));
  app.get('/:repoId/git', context => dispatch(context, false));
  if (defaultRepo) app.get('/', context => context.redirect(repositoryUrl(defaultRepo), 308));
  else app.get('/', async () => await fileResponse(resolve(options.dist, 'index.html'), { 'cache-control': 'no-store' })
    || options.json({ error: 'Library page not found' }, 404));
  return app;
}
