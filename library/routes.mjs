import { createSessionLeases } from './session-leases.mjs';
import { readdir, stat } from 'node:fs/promises';
import { resolve, relative, basename, sep } from 'node:path';
import { fileResponse } from '../file-response.mjs';
import { createLibrarySearch } from './search.mjs';
import { watchLibraryFiles } from './watch.mjs';
import { watchLibraryTree } from './tree-watch.mjs';
import { pdfDocument, pdfPage } from './pdf.mjs';
import { identifyFile } from './file-kind.mjs';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

const ignoredNames = new Set(['.git', '.work', '.archive', 'node_modules']);

export function createLibraryRoutes({ root, dist, checkedPath, json, renderMarkdown, compileTypst, typstPage, typstFile,
  onViewerChange = () => {}, apiBase = '/api', dataDirectory, getSearchPaths }) {
  const app = new Hono();
  const sessionLeases = createSessionLeases(onViewerChange);
  const leaseSweep = setInterval(() => sessionLeases.sweep(), 15000);
  leaseSweep.unref();
  app.post('/api/library/session-leases', async context => {
    try {
      const origin = context.req.header('origin');
      if (origin && origin !== new URL(context.req.url).origin) return json({ error: 'Cross-origin retention is forbidden' }, 403);
      if (!context.req.header('content-type')?.startsWith('application/json')) return json({ error: 'Expected application/json' }, 415);
      const { client, paths, version } = await context.req.json();
      if (typeof client !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(client) || !Array.isArray(paths) || paths.length > 64)
        return json({ error: 'Invalid session lease' }, 400);
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 0)) return json({ error: 'Invalid lease version' }, 400);
      const files = paths.flatMap(path => {
        try { return [checkedPath(path)]; }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      });
      sessionLeases.update(client, files, version);
      return json({ ok: true });
    } catch (error) { return json({ error: error.message }, 400); }
  });
  const search = createLibrarySearch(root, dataDirectory, getSearchPaths);
  function relativePath(file) { return relative(root, file).split(sep).join('/'); }

  async function tree(directory = root) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (directory !== root && error.code === 'ENOENT') return []; throw error; }
    const nodes = [];
    for (const entry of entries) {
      if (ignoredNames.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = resolve(directory, entry.name);
      if (dataDirectory && file === dataDirectory) continue;
      if (entry.isSymbolicLink()) continue;
      const info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (entry.isDirectory()) {
        const children = await tree(file);
        if (children.length) {
          nodes.push({ name: entry.name, path: relativePath(file), absolutePath: file, type: 'directory', children,
            modified: info.mtime.toISOString() });
        }
      } else if (entry.isFile()) {
        nodes.push({ name: entry.name, path: relativePath(file), type: 'file', modified: info.mtime.toISOString() });
      }
    }
    nodes.sort((a, b) => a.type === b.type
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.type === 'directory' ? -1 : 1);
    return nodes;
  }

  async function document(path, view) {
    try {
      const file = checkedPath(path);
      const info = await stat(file);
      if (!info.isFile()) return json({ error: 'Not a file' }, 400);
      const name = basename(file), kind = await identifyFile(file);
      const meta = { path: relativePath(file), absolutePath: file, name, size: info.size, modified: info.mtime.toISOString() };
      if (kind.type === 'markdown') {
        const source = kind.source;
        return json({ type: 'markdown', ...meta, lineCount: source ? source.split('\n').length : 0,
          source, html: renderMarkdown(source, { allowRawHtml: true }) });
      }
      if (kind.type === 'typst') {
        const source = kind.source;
        if (view === 'raw') return json({ type: 'typst', ...meta,
          lineCount: source ? source.split('\n').length : 0, source, outline: [], anchors: [], pages: [], compile: null });
        const compiled = await compileTypst(file, source, info.mtimeMs);
        return json({ type: 'typst', ...meta, lineCount: source ? source.split('\n').length : 0, source,
          outline: compiled.outline || [], anchors: compiled.anchors || [],
          pages: compiled.info.map((page, index) => ({ url: `${apiBase}/typst/page?id=${compiled.id}&page=${index + 1}`,
            width: page.width, height: page.height })),
          compile: { status: compiled.diagnostics.some(item => item.severity === 'error') ? 'failed' : 'success',
            diagnostics: compiled.diagnostics.filter(item => item.severity === 'error') } });
      }
      if (kind.type === 'pdf') {
        const compiled = await pdfDocument(file, info);
        return json({ type: 'pdf', ...meta, outline: compiled.outline,
          pages: compiled.pages.map((page, index) => ({ ...page,
            url: `${apiBase}/pdf/page?path=${encodeURIComponent(relativePath(file))}&page=${index + 1}` })) });
      }
      if (kind.type === 'image' || kind.type === 'binary') return json({ type: kind.type, ...meta, mime: kind.mime, format: kind.format,
        url: `${apiBase}/asset?path=${encodeURIComponent(relativePath(file))}` });
      const source = kind.source;
      return json({ type: 'text', ...meta, lineCount: source ? source.split('\n').length : 0, source, text: source });
    } catch (error) {
      return json({ error: error.code === 'ENOENT' ? 'Not found' : error.message }, error.code === 'ENOENT' ? 404 : 400);
    }
  }

  function events(path, assetPaths, context) {
    let file;
    try { file = checkedPath(path); }
    catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
    const assets = new Map();
    for (const assetPath of assetPaths.slice(0, 128)) {
      try { assets.set(checkedPath(assetPath), assetPath); }
      catch { /* Missing or external resources have nothing to watch. */ }
    }
    let stop;
    let viewing = false;
    let finish;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      stop?.();
      stop = null;
      if (viewing) { viewing = false; onViewerChange(file, false); }
      finish?.();
    };
    const response = streamSSE(context, async stream => {
      await new Promise(resolve => {
        finish = resolve;
        const send = (event, data) => { void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(close); };
        stream.onAbort(close);
        stop = watchLibraryFiles(file, assets.keys(), ({ documentChanged, assets: changedAssets }) => {
          if (documentChanged) send('document', {});
          if (changedAssets.length) send('assets', { paths: changedAssets.map(asset => assets.get(asset)) });
        });
        viewing = true;
        onViewerChange(file, true);
        send('connected', {});
      });
    }, error => {
      close();
      return stream.writeSSE({ event: 'error', data: error.message });
    });
    response.headers.set('cache-control', 'no-store');
    return response;
  }

  async function page() {
    try {
      return await fileResponse(resolve(dist, 'index.html'), { 'cache-control': 'no-store' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return json({ error: 'Build the frontend first: npm run build' }, 503);
    }
  }

  app.get('/', page);
  app.get('/api/search', async context => {
    try {
      const result = await search(new URL(context.req.url).searchParams);
      return json(result);
    } catch (error) { return json({ error: error.message }, 400); }
  });
  app.get('/api/git/status', async context => {
    try {
      const { sharedGitStatus } = await import('./git-cache.mjs');
      return json(await sharedGitStatus(root, { force: context.req.query('refresh') === '1' }));
    } catch (error) { return json({ error: error.message }, 500); }
  });
  app.get('/api/git/diff', async context => {
    try {
      const { gitDiff } = await import('./git-diff.mjs');
      return json(await gitDiff(root, context.req.query('path'), context.req.raw.signal, context.req.query('scope') || 'all'));
    } catch (error) { return json({ error: error.message }, 400); }
  });
  let pendingTree;
  app.get('/api/tree', async () => {
    pendingTree ||= tree().then(children => ({ name: basename(root), absolutePath: root, children }))
      .finally(() => { pendingTree = undefined; });
    return json(await pendingTree);
  });
  app.get('/api/library/tree-events', context => {
    const response = streamSSE(context, async stream => {
      let stop, timer;
      await new Promise(done => {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          stop?.(); clearInterval(timer); done();
        };
        stream.onAbort(close);
        if (closed) return;
        const send = event => { void stream.writeSSE({ event, data: '{}' }).catch(close); };
        stop = watchLibraryTree(root, error => { if (error) close(); else send('tree'); }, dataDirectory);
        timer = setInterval(() => send('ping'), 15000);
        timer.unref();
        send('connected');
      });
    });
    response.headers.set('cache-control', 'no-store');
    return response;
  });
  app.get('/api/document', context => {
    const url = new URL(context.req.url);
    return document(url.searchParams.get('path'), url.searchParams.get('view'));
  });
  app.get('/api/library/events', context => {
    const url = new URL(context.req.url);
    return events(url.searchParams.get('path'), url.searchParams.getAll('asset'), context);
  });
  app.get('/api/typst/page', context => {
    const url = new URL(context.req.url);
    const id = url.searchParams.get('id');
    const file = typstFile?.(id);
    if (!file) return json({ error: 'Typst document expired' }, 410);
    try { checkedPath(file); }
    catch { return json({ error: 'Typst document unavailable' }, 410); }
    return typstPage(id, Number(url.searchParams.get('page')), url.searchParams.get('format'));
  });
  app.get('/api/pdf/page', async context => {
    try {
      const url = new URL(context.req.url);
      const file = checkedPath(url.searchParams.get('path'));
      if ((await identifyFile(file)).type !== 'pdf') return json({ error: 'Not a PDF' }, 400);
      return await pdfPage(file, Number(url.searchParams.get('page')));
    } catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  app.get('/api/asset', async context => {
    try {
      const file = checkedPath(new URL(context.req.url).searchParams.get('path'));
      const kind = await identifyFile(file);
      return await fileResponse(file, { 'cache-control': 'no-store', 'content-type': kind.mime, 'x-content-type-options': 'nosniff' }) || json({ error: 'Asset not found' }, 404);
    } catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  return app;
}
