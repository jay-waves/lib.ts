import { prepareTypstImage } from './library/typst-image.mjs';
import { realpathSync } from 'node:fs';
import { sweepTypstCache } from './library/typst-cache.mjs';
import { createByteCache, svgImageBytes } from './library/byte-cache.mjs';
import { resolve, dirname, relative, sep, isAbsolute, parse } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { prepareInlineSvg, pageSvg, pageInfoFromArtifact } from './typst-pages.mjs';
import { anchorTable } from './typst-anchors.mjs';
import { compileTypstVector } from './typst-compile.mjs';
import { analyzeTypst, anchorBlocks } from './typst-tree.mjs';
import { renderMarkdown } from './markdown-renderer.mjs';
import { createRepositoryRoutes } from './library/repo-routes.mjs';
import { openRepositories } from './library/repositories.mjs';
import { prewarmPdfEngine, sweepPdfDocuments } from './library/pdf.mjs';
import { repositoryUrl } from './library/paths.mjs';
import { createTypstRuntime, packageRoot } from './typst-runtime.mjs';

import { createLibraryOpenRoutes } from './library/open-routes.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const libraryDist = resolve(dist, 'library');
const rootArgument = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
const serviceRoot = realpathSync(resolve(rootArgument || process.cwd()));
const dataDirectory = resolve(process.env.LIBRARY_DATA_DIRECTORY || resolve(here, 'data'));
const repositories = await openRepositories(dataDirectory);
const defaultRepo = rootArgument ? await repositories.add(serviceRoot) : repositories.list()[0];
const memoryEnabled = process.env.TYPST_WASM_MEMORY === '1';
let compileRoot = '';
let typstLock = Promise.resolve();
const libraryTypstCache = new Map();
const libraryViewers = new Map();
const PAGE_IDLE_MS = 5 * 60_000;
const DOCUMENT_IDLE_MS = 15 * 60_000;
let closing = false;
let httpServer;

function inside(base, path) {
  const rel = relative(base, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function checkedDocumentPath(value, root = serviceRoot) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid path');
  const target = resolve(root, value);
  if (!inside(root, target)) throw new Error('File is outside the repository root');
  const real = realpathSync(target);
  if (!inside(root, real)) throw new Error('File is outside the repository root');
  return real;
}
function checkedLibraryPath(value, root) {
  const file = checkedDocumentPath(value, root);
  if (inside(dataDirectory, file)) throw new Error('Application data is private');
  return file;
}
function libraryRelative(path) { return relative(serviceRoot, path).split(sep).join('/'); }

function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function pathKey(file) { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file); }
function mib(bytes) { return Math.round((Number(bytes) || 0) / 1048576 * 10) / 10; }
function memorySample(stage, details = {}) {
  if (!memoryEnabled) return;
  const memory = process.memoryUsage();
  emit({ event: 'memory', stage, rssMiB: mib(memory.rss), heapMiB: mib(memory.heapUsed),
    externalMiB: mib(memory.external), arrayBuffersMiB: mib(memory.arrayBuffers), ...details });
}
function profile(stage, start) {
  if (process.env.TYPST_WASM_PROFILE === '1') emit({ event: 'profile', stage, ms: Math.round(performance.now() - start) });
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
function virtualPath(file, root) {
  return `/workspace/${relative(root, file).split(sep).join('/')}`;
}
function unvirtual(path) {
  if (path.startsWith('/workspace/')) return resolve(compileRoot, path.slice('/workspace/'.length));
  if (path.startsWith('/packages/')) {
    const namespace = path.split('/')[2];
    if (!['local', 'preview'].includes(namespace)) return undefined;
    return resolve(packageRoot(namespace), path.slice(`/packages/${namespace}/`.length));
  }
  return undefined;
}
const typstRuntime = createTypstRuntime({ emit, memorySample, unvirtual });
function logTypstDiagnostics(items, sourceFile) {
  for (const item of items) {
    const file = item.file || (item.path ? unvirtual(item.path) || item.path : sourceFile);
    const location = item.range ? `:${typeof item.range === 'string' ? item.range : JSON.stringify(item.range)}` : '';
    console.log(`Typst ${item.severity || 'error'}: ${file}${location}: ${String(item.message).replace(/\s*\n\s*/g, ' ')}`);
  }
}
function extractSvgPage(svg, page) {
  const tags = /<g\b[^>]*class="typst-page"[^>]*>/g;
  const first = tags.exec(svg);
  const root = svg.match(/^<svg\b[^>]*>/)?.[0];
  if (!root || !first) throw new Error('Typst renderer returned invalid page SVG');
  let match = first;
  for (let index = 1; index < page && match; index++) match = tags.exec(svg);
  if (!match) return;
  const start = match.index;
  let depth = 0, end = -1;
  for (const tag of svg.slice(start).matchAll(/<g\b[^>]*>|<\/g\s*>/g)) {
    depth += tag[0][1] === '/' ? -1 : 1;
    if (!depth) { end = start + tag.index + tag[0].length; break; }
  }
  if (end < 0) throw new Error(`Could not parse Typst SVG page ${page}`);
  const width = Number(match[0].match(/data-page-width="([\d.]+)/)?.[1]);
  const height = Number(match[0].match(/data-page-height="([\d.]+)/)?.[1]);
  const offset = match[0].match(/transform="translate\(([\d.-]+),\s*([\d.-]+)\)"/);
  const x = Number(offset?.[1] || 0), y = Number(offset?.[2] || 0);
  if (!(width > 0 && height > 0)) throw new Error(`Invalid Typst SVG page ${page} dimensions`);
  const pageRoot = root.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${width} ${height}"`)
    .replace(/\b(width|height|data-width|data-height)="[^"]*"/g, (_attr, name) => `${name}="${name.endsWith('width') ? width : height}"`);
  return { svg: `${svg.slice(0, first.index).replace(root, pageRoot)}${svg.slice(start, end)}</svg>`, width, height };
}
function withTypstLock(action) {
  const task = typstLock.then(action, action);
  typstLock = task.catch(() => {});
  return task;
}
function libraryDiagnostics(items, sourceFile) {
  return (items || []).map(item => {
    const rawPath = item.path || item.file;
    const resolved = typeof rawPath === 'string' ? unvirtual(rawPath) : undefined;
    const file = resolved && inside(serviceRoot, resolved) ? libraryRelative(resolved)
      : typeof rawPath === 'string' ? rawPath : libraryRelative(sourceFile);
    let range = null;
    if (typeof item.range === 'string') {
      const match = item.range.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
      if (match) range = { start: { line: Number(match[1]), column: Number(match[2]) },
        end: { line: Number(match[3]), column: Number(match[4]) } };
    } else if (item.range?.start && item.range?.end) {
      range = { start: item.range.start, end: item.range.end };
    }
    return { file, severity: ['error', 'warning', 'info', 'hint'].includes(item.severity) ? item.severity : 'error',
      message: String(item.message || 'Typst compilation failed'), range };
  });
}
async function compileLibraryTypst(file, source, modified) {
  const key = `${pathKey(file)}:${modified}`;
  const cached = [...libraryTypstCache.values()].find(item => item.key === key);
  if (cached) { cached.lastUsed = Date.now(); return cached; }
  return withTypstLock(async () => {
    const afterWait = [...libraryTypstCache.values()].find(item => item.key === key);
    if (afterWait) { afterWait.lastUsed = Date.now(); return afterWait; }
    const parsed = await analyzeTypst(source);
    const marked = anchorBlocks(source, parsed.blocks, { headings: parsed.headings, minLineGap: 24 });
    const previousRoot = compileRoot;
    const root = parse(file).root;
    compileRoot = root;
    try {
      let clock = performance.now();
      const runtime = await typstRuntime.init();
      profile('library wasm wait', clock); clock = performance.now();
      await typstRuntime.initFonts();
      profile('library fonts wait', clock); clock = performance.now();
      const vpath = virtualPath(file, root);
      const result = await compileTypstVector(runtime.compiler, vpath, marked.text,
        { queryAnchors: true, loadMissingPackage: typstRuntime.loadMissingPreviewPackage });
      profile('library compile/vector', clock); clock = performance.now();
      const diagnostics = libraryDiagnostics(result.diagnostics, file);
      logTypstDiagnostics(diagnostics, file);
      const id = randomBytes(12).toString('hex');
      const pages = result.artifact
        ? (await pageInfoFromArtifact(runtime.renderer, result.artifact)).map(({ width, height }) => ({ width, height }))
        : [];
      profile('library page info', clock);
      const anchors = anchorTable(result.anchors || [], marked.positions, pages);
      const outline = parsed.headings.map(heading => {
        const anchor = anchors.find(item => item.line === heading.line);
        return { ...heading, position: anchor ? { page: anchor.page,
          y: anchor.y / pages[anchor.page - 1].height } : null };
      });
      const item = { id, key, file, artifact: result.artifact, info: pages,
        pages: createByteCache({ maxEntries: 16, maxBytes: 8 * 1024 * 1024, sizeOf: svgImageBytes }), diagnostics,
        pendingPages: new Map(), anchors, outline, lastUsed: Date.now(), inUse: 0 };
      libraryTypstCache.set(id, item);
      sweepLibraryTypstCache(Date.now(), id);
      return item;
    } finally { compileRoot = previousRoot; }
  });
}
async function libraryTypstPage(id, page, format) {
  const item = libraryTypstCache.get(id);
  if (!item) return json({ error: 'Document expired; reload its metadata' }, 410);
  if (!Number.isInteger(page) || page < 1 || page > item.info.length) return json({ error: 'Page unavailable' }, 404);
  item.lastUsed = Date.now();
  item.inUse++;
  try {
    let svg = item.pages.get(page);
    if (!svg) {
      try {
        let pending = item.pendingPages.get(page);
        if (!pending) {
          pending = (async () => {
            const clock = performance.now();
            const full = await pageSvg(typstRuntime.value, item.artifact, item.info, page - 1);
            const pageText = extractSvgPage(full, page)?.svg;
            if (!pageText) throw new Error('Page SVG unavailable');
            const svg = prepareTypstImage(prepareInlineSvg(pageText, `library-${id}-${page}`));
            item.pages.set(page, svg);
            profile(`library svg page ${page}`, clock);
            return svg;
          })();
          item.pendingPages.set(page, pending);
        }
        try { svg = await pending; } finally { item.pendingPages.delete(page); }
      } catch (error) { return json({ error: error.message }, 500); }
    }
    if (format === 'json') return json(svg);
    return new Response(svg.svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' } });
  } finally { item.inUse--; item.lastUsed = Date.now(); }
}
function isDocumentActive(file) { return libraryViewers.has(pathKey(file)); }
function sweepLibraryTypstCache(now = Date.now(), protectedId = null) {
  sweepTypstCache(libraryTypstCache, { now, protectedId, isActive: isDocumentActive, fileKey: pathKey,
    pageIdleMs: PAGE_IDLE_MS, documentIdleMs: DOCUMENT_IDLE_MS });
}
const libraryRoutes = createRepositoryRoutes({
  repositories, defaultRepo, dataDirectory, initialRoot: serviceRoot,
  dist: libraryDist,
  checkedPath: checkedLibraryPath,
  json,
  renderMarkdown,
  compileTypst: compileLibraryTypst,
  typstPage: libraryTypstPage,
  typstFile: id => libraryTypstCache.get(id)?.file,
  onViewerChange(file, connected) {
    const key = pathKey(file);
    const count = (libraryViewers.get(key) || 0) + (connected ? 1 : -1);
    if (count > 0) libraryViewers.set(key, count);
    else libraryViewers.delete(key);
  },
});

function protectedResponse(response) {
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}
const app = new Hono();
app.use('*', async (context, next) => {
  await next();
  context.res = protectedResponse(context.res);
});
const externalOpen = createLibraryOpenRoutes({ repositories, defaultRepo, checkedPath: checkedLibraryPath, json });
app.route('/', externalOpen.app);
app.get('/assets/*', serveStatic({ root: dist }));
app.route('/', libraryRoutes);
app.notFound(() => new Response('Not found', { status: 404 }));
const listenPort = Number(process.env.NODE_PREVIEW_PORT || 49191);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)
  throw new Error('NODE_PREVIEW_PORT must be an integer from 1 to 65535');
httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: listenPort });
await new Promise(resolve => httpServer.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
const libraryUrl = defaultRepo ? `${baseUrl}${repositoryUrl(defaultRepo)}` : `${baseUrl}/`;
emit({ event: 'ready', baseUrl, root: serviceRoot, repoId: defaultRepo?.id || null,
  libraryUrl, dataDirectory, urls: { library: libraryUrl } });
if (process.env.WASM_PREWARM !== '0' && process.env.TYPST_WASM_PREWARM !== '0') {
  const clock = performance.now();
  // initFonts also initializes WASM and shares its promise with incoming compiles.
  // Warming only WASM leaves the entire font setup on the first document request.
  void typstRuntime.initFonts().then(() => profile('startup typst wasm/fonts', clock))
    .catch(error => emit({ event: 'notice', kind: 'typst', message: `Typst prewarm failed: ${error}` }));
  void prewarmPdfEngine().then(() => profile('startup pdfium wasm', clock))
    .catch(error => emit({ event: 'notice', kind: 'pdf', message: `PDFium WASM prewarm failed: ${error}` }));
}
const resourceSweep = setInterval(() => {
  sweepLibraryTypstCache();
  void sweepPdfDocuments(isDocumentActive)
    .catch(error => emit({ event: 'notice', kind: 'pdf', message: `PDF cleanup failed: ${error}` }));
}, 60_000);
resourceSweep.unref();


async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(resourceSweep);
  externalOpen.close();
  httpServer.closeAllConnections();
  httpServer.close();
  try { await libraryRoutes.closeReadingState(); }
  catch (error) { emit({ event: 'notice', kind: 'reading', message: `Reading state save failed: ${error}` }); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
