import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, basename, extname, sep } from 'node:path';
import { fileResponse } from '../file-response.mjs';
import { watchLibraryFiles } from './watch.mjs';
import { pdfDocument, pdfPage } from './pdf.mjs';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

const ignoredNames = new Set(['.git', '.work', '.archive', 'node_modules']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);

export function createLibraryRoutes({ root, dist, checkedPath, json, renderMarkdown, compileTypst, typstPage,
  onViewerChange = () => {} }) {
  const app = new Hono();
  function relativePath(file) { return relative(root, file).split(sep).join('/'); }

  async function tree(directory = root) {
    const entries = await readdir(directory, { withFileTypes: true });
    const nodes = [];
    for (const entry of entries) {
      if (ignoredNames.has(entry.name) || entry.name.startsWith('.')) continue;
      const file = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const children = await tree(file);
        if (children.length) {
          const info = await stat(file);
          nodes.push({ name: entry.name, path: relativePath(file), type: 'directory', children,
            modified: info.mtime.toISOString() });
        }
      } else if (entry.isFile()) nodes.push({ name: entry.name, path: relativePath(file), type: 'file' });
    }
    nodes.sort((a, b) => a.type === b.type
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : a.type === 'directory' ? -1 : 1);
    return nodes;
  }

  async function document(path) {
    try {
      const file = checkedPath(path);
      const info = await stat(file);
      if (!info.isFile()) return json({ error: 'Not a file' }, 400);
      const name = basename(file), kind = extname(file).toLowerCase();
      const meta = { path: relativePath(file), absolutePath: file, name, size: info.size, modified: info.mtime.toISOString() };
      if (kind === '.md') {
        const source = await readFile(file, 'utf8');
        return json({ type: 'markdown', ...meta, lineCount: source ? source.split('\n').length : 0,
          source, html: renderMarkdown(source, { allowRawHtml: true }) });
      }
      if (kind === '.typ') {
        const source = await readFile(file, 'utf8');
        const compiled = await compileTypst(file, source, info.mtimeMs);
        return json({ type: 'typst', ...meta, lineCount: source ? source.split('\n').length : 0, source,
          outline: compiled.outline || [],
          pages: compiled.info.map((page, index) => ({ url: `/api/typst/page?id=${compiled.id}&page=${index + 1}`,
            width: page.width, height: page.height })),
          compile: { status: compiled.diagnostics.some(item => item.severity === 'error') ? 'failed' : 'success',
            diagnostics: compiled.diagnostics.filter(item => item.severity === 'error') } });
      }
      if (kind === '.pdf') {
        const compiled = await pdfDocument(file, info);
        return json({ type: 'pdf', ...meta, outline: compiled.outline,
          pages: compiled.pages.map((page, index) => ({ ...page,
            url: `/api/pdf/page?path=${encodeURIComponent(relativePath(file))}&page=${index + 1}` })) });
      }
      if (imageExtensions.has(kind)) return json({ type: 'image', ...meta,
        url: `/api/asset?path=${encodeURIComponent(relativePath(file))}` });
      const source = await readFile(file, 'utf8');
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

  async function page(url) {
    const pageName = url.pathname === '/' && url.searchParams.get('path') ? 'viewer.html' : 'index.html';
    if (url.pathname === '/' && url.searchParams.get('path')) {
      try { checkedPath(url.searchParams.get('path')); }
      catch (error) { return json({ error: error.message }, 400); }
    }
    try {
      return await fileResponse(resolve(dist, pageName), { 'cache-control': 'no-store' });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return json({ error: 'Build the frontend first: npm run build' }, 503);
    }
  }

  app.get('/', context => page(new URL(context.req.url)));
  for (const path of ['/notes', '/notes/', '/notes/*']) app.get(path, context => page(new URL(context.req.url)));
  app.get('/api/tree', async () => json({ name: basename(root), children: await tree() }));
  app.get('/api/document', context => document(new URL(context.req.url).searchParams.get('path')));
  app.get('/api/library/events', context => {
    const url = new URL(context.req.url);
    return events(url.searchParams.get('path'), url.searchParams.getAll('asset'), context);
  });
  app.get('/api/typst/page', context => {
    const url = new URL(context.req.url);
    return typstPage(url.searchParams.get('id'), Number(url.searchParams.get('page')));
  });
  app.get('/api/pdf/page', async context => {
    try {
      const url = new URL(context.req.url);
      const file = checkedPath(url.searchParams.get('path'));
      if (extname(file).toLowerCase() !== '.pdf') return json({ error: 'Not a PDF' }, 400);
      return await pdfPage(file, Number(url.searchParams.get('page')));
    } catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  app.get('/api/asset', async context => {
    try {
      const file = checkedPath(new URL(context.req.url).searchParams.get('path'));
      return await fileResponse(file, { 'cache-control': 'no-store' }) || json({ error: 'Asset not found' }, 404);
    } catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  return app;
}
