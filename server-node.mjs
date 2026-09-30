import { existsSync, realpathSync, watch as watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute, parse, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { fileResponse } from './file-response.mjs';
import { prepareInlineSvg, pageSvg, pageInfoFromArtifact } from './typst-pages.mjs';
import { anchorTable, positionForLine, lineForPosition } from './typst-anchors.mjs';
import { compileTypstVector } from './typst-compile.mjs';
import { analyzeTypst, anchorBlocks } from './typst-tree.mjs';
import { renderMarkdown } from './markdown-renderer.mjs';
import { createLibraryRoutes } from './library/routes.mjs';
import { prewarmPdfEngine, sweepPdfDocuments } from './library/pdf.mjs';
import { createMarkdownPreview } from './markdown-preview.mjs';
import { createNeovimBridge } from './neovim-bridge.mjs';
import { createTypstRuntime, packageRoot } from './typst-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const libraryDist = resolve(dist, 'library');
const rootArgument = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
const serviceRoot = realpathSync(resolve(rootArgument || process.cwd()));
const memoryEnabled = process.env.TYPST_WASM_MEMORY === '1';
const sessionContext = new AsyncLocalStorage();
const sessions = new Map();
let defaultSession;
function currentSession() { return sessionContext.getStore() || defaultSession; }
function sessionProxy(field) {
  return new Proxy({}, {
    get(_target, key) { return currentSession()[field][key]; },
    set(_target, key, value) { currentSession()[field][key] = value; return true; },
    ownKeys() { return Reflect.ownKeys(currentSession()[field]); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(currentSession()[field], key);
      return descriptor && { ...descriptor, configurable: true };
    },
  });
}
const streams = sessionProxy('streams');
const activeDocuments = sessionProxy('activeDocuments');
const fileWatchers = sessionProxy('fileWatchers');
const watchTimers = sessionProxy('watchTimers');
const typst = sessionProxy('typst');
function emptyTypstOutput() {
  return { pages: [], sizes: [], svgPages: [], svgPending: [], pageInfo: [], artifact: null,
    textHits: [], anchors: [], outline: [] };
}
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
  if (!inside(root, target)) throw new Error('File is outside the Neovim working directory');
  const real = realpathSync(target);
  if (!inside(root, real)) throw new Error('File is outside the Neovim working directory');
  return real;
}
function libraryRelative(path) { return relative(serviceRoot, path).split(sep).join('/'); }

const neovim = createNeovimBridge({ getSessionId: () => currentSession().id });
const { emit } = neovim;
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
function publish(kind, event, data = {}) {
  const clients = [...streams[kind]];
  return Promise.all(clients.map(client => client.write(event, data).catch(() => client.close())));
}
function createEditorSession(id) {
  const session = {
    id, root: id ? null : serviceRoot,
    streams: { markdown: new Set(), typst: new Set() },
    activeDocuments: { markdown: null, typst: null },
    fileWatchers: { markdown: null, typst: null },
    watchTimers: { markdown: null, typst: null },
    typst: { file: '', text: '', root: '', line: 1, revision: 0, buffer: null, version: 0,
      ...emptyTypstOutput(), diagnostics: [], mathFontFallback: false },
    typstEpoch: 0, pendingCompile: null, activeCompile: null,
    compileRunning: false, completedTypst: null,
  };
  session.markdownPreview = createMarkdownPreview({ dist, json, emit, publish, renderMarkdown });
  return session;
}
defaultSession = createEditorSession(null);
function getSession(id, create = false) {
  if (!id || id === 'default') return defaultSession;
  if (!/^[a-f0-9]{64}$/.test(id)) return null;
  let session = sessions.get(id);
  if (!session && create) { session = createEditorSession(id); sessions.set(id, session); }
  return session;
}
const markdownPreview = new Proxy({}, {
  get(_target, key) {
    const value = currentSession().markdownPreview[key];
    return typeof value === 'function' ? value.bind(currentSession().markdownPreview) : value;
  },
});
function streamRoute(kind, context) {
  const clients = streams[kind];
  const response = streamSSE(context, async stream => {
    let finish;
    let finished = false;
    const ended = new Promise(resolve => { finish = resolve; });
    const end = () => {
      if (finished) return;
      finished = true;
      clients.delete(client);
      finish();
    };
    const client = {
      write(event, data) { return stream.writeSSE({ event, data: JSON.stringify(data) }); },
      close() {
        end();
        return stream.close();
      },
    };
    clients.add(client);
    stream.onAbort(end);
    await stream.writeSSE({ data: 'connected' });
    await ended;
  }, error => {
    emit({ event: 'notice', message: `SSE stream failed: ${error.message}` });
  });
  response.headers.set('cache-control', 'no-store');
  return response;
}

function virtualPath(file, root) {
  return `/workspace/${relative(root, file).split(sep).join('/')}`;
}
function unvirtual(path) {
  if (path.startsWith('/workspace/')) return resolve(typst.root, path.slice('/workspace/'.length));
  if (path.startsWith('/packages/')) {
    const namespace = path.split('/')[2];
    if (!['local', 'preview'].includes(namespace)) return undefined;
    return resolve(packageRoot(namespace), path.slice(`/packages/${namespace}/`.length));
  }
  return undefined;
}
const typstRuntime = createTypstRuntime({ emit, memorySample, unvirtual });
function emitTypstDiagnostics(doc) {
  emit({ event: 'diagnostics', kind: 'typst', file: typst.file, buffer: doc.buffer,
    revision: doc.revision, diagnostics: visibleTypstDiagnostics(typst.diagnostics).map(item => ({
      ...item, file: item.path ? unvirtual(item.path) || typst.file : typst.file,
    })) });
}
async function publishTypstResult(doc) {
  emitTypstDiagnostics(doc);
  await publish('typst', 'refresh');
}
async function failTypst(doc, file, diagnostics) {
  currentSession().completedTypst = null;
  Object.assign(typst, emptyTypstOutput());
  typst.diagnostics = diagnostics.length ? diagnostics
    : [{ severity: 'error', message: 'Typst compilation produced no pages' }];
  logTypstDiagnostics(typst.diagnostics, file);
  await publishTypstResult(doc);
}
function visibleTypstDiagnostics(items) { return items.filter(item => item.severity === 'error'); }
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
function transformProduct(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function svgTransform(value, parent) {
  let matrix = parent;
  for (const item of value?.matchAll(/(matrix|translate|scale)\(([^)]*)\)/g) || []) {
    const n = item[2].match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    if (item[1] === 'matrix' && n.length === 6) matrix = transformProduct(matrix, n);
    else if (item[1] === 'translate') matrix = transformProduct(matrix, [1, 0, 0, 1, n[0] || 0, n[1] || 0]);
    else if (item[1] === 'scale') matrix = transformProduct(matrix, [n[0] || 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
  }
  return matrix;
}
function svgText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_match, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()];
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : '';
  }).replace(/\s+/g, ' ').trim();
}
function textHitsFromPages(pages, source) {
  const lines = source.split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim());
  const exactLines = new Map();
  lines.forEach((line, index) => {
    for (const value of [line, line.replace(/^=+\s+|^[-+*]\s+/, '')]) {
      if (!value) continue;
      if (!exactLines.has(value)) exactLines.set(value, []);
      exactLines.get(value).push(index + 1);
    }
  });
  const hits = [];
  let previousLine = 1;
  pages.forEach((page, pageIndex) => {
    const start = page.svg.search(/<g\b[^>]*class="typst-page"/);
    if (start < 0) return;
    const stack = [];
    const tags = /<\/?g\b[^>]*>|<h5:div\b[^>]*class="tsel"[^>]*>[\s\S]*?<\/h5:div>/g;
    tags.lastIndex = start;
    for (const match of page.svg.matchAll(tags)) {
      const tag = match[0];
      if (tag.startsWith('</g')) { stack.pop(); continue; }
      if (tag.startsWith('<g')) {
        const parent = stack.at(-1)?.matrix || [1, 0, 0, 1, 0, 0];
        const matrix = svgTransform(tag.match(/\btransform="([^"]*)"/)?.[1], parent);
        stack.push({ matrix, point: tag.includes('class="typst-text"')
          ? { x: matrix[4], y: matrix[5] } : stack.at(-1)?.point });
        continue;
      }
      const point = stack.at(-1)?.point;
      if (!point) continue;
      const rendered = svgText(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</h5:div>')));
      if (rendered.length < 2) continue;
      const candidates = exactLines.get(rendered);
      let line = candidates?.find(value => value >= previousLine) || candidates?.at(-1);
      if (!line) {
        const start = Math.max(0, previousLine - 21);
        const end = Math.min(lines.length, previousLine + 100);
        for (let index = start; index < end; index++) {
          const value = lines[index];
          if (value.includes(rendered) || (value.length >= 4 && rendered.includes(value))) {
            line = index + 1; break;
          }
        }
      }
      if (!line) continue;
      previousLine = line;
      hits.push({ page: pageIndex + 1, line, x: point.x, y: point.y });
    }
  });
  return hits;
}
async function compileTypst(doc, epoch) {
  const obsolete = () => epoch !== currentSession().typstEpoch || closing;
  const file = resolve(doc.file);
  const root = parse(file).root;
  currentSession().completedTypst = null;
  currentSession().typst = { ...typst, file, root, text: doc.text, line: doc.line || 1, revision: doc.revision || 0,
    buffer: doc.buffer, version: typst.version + 1,
    ...emptyTypstOutput(), diagnostics: [], mathFontFallback: false };
  const version = typst.version;
  try {
    let clock = performance.now();
    const runtime = await typstRuntime.init();
    profile('wasm wait', clock); clock = performance.now();
    await typstRuntime.initFonts();
    if (obsolete()) return;
    profile('fonts wait', clock); clock = performance.now();
    const vpath = virtualPath(file, root);
    const editorConnected = neovim.connected();
    const parsed = editorConnected ? await analyzeTypst(doc.text) : { blocks: [], headings: [] };
    if (obsolete()) return;
    if (editorConnected) profile('source analysis', clock);
    clock = performance.now();
    const marked = editorConnected ? anchorBlocks(doc.text, parsed.blocks) : { text: doc.text, positions: [] };
    memorySample('compile-start', { version, sourceBytes: Buffer.byteLength(doc.text) });
    const result = await compileTypstVector(runtime.compiler, vpath, marked.text,
      { queryAnchors: editorConnected, loadMissingPackage: typstRuntime.loadMissingPreviewPackage });
    if (obsolete()) return;
    profile('compile/vector/query', clock); clock = performance.now();
    typst.mathFontFallback = result.mathFontFallback;
    if (!result.artifact) {
      await failTypst(doc, file, result.diagnostics);
      return;
    }
    typst.diagnostics = result.diagnostics;
    logTypstDiagnostics(typst.diagnostics, file);
    const info = await pageInfoFromArtifact(runtime.renderer, result.artifact);
    if (obsolete()) return;
    profile('render session/page info', clock); clock = performance.now();
    typst.artifact = result.artifact;
    typst.pageInfo = info;
    typst.svgPages = Array(info.length);
    typst.svgPending = Array(info.length);
    typst.textHits = [];
    typst.pages = info.map((_page, index) => `/asset/page-${index + 1}.svg?v=${version}`);
    typst.sizes = info.map(({ width, height }) => ({ width, height }));
    typst.anchors = anchorTable(result.anchors || [], marked.positions, typst.sizes);
    if (editorConnected) profile('anchor table', clock);
    typst.outline = parsed.headings;
    currentSession().completedTypst = { file, text: doc.text, revision: doc.revision };
    await publishTypstResult(doc);
  } catch (error) {
    if (obsolete()) return;
    await failTypst(doc, file, [{ severity: 'error', message: String(error) }]);
  }
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
    const previousRoot = typst.root;
    const root = parse(file).root;
    typst.root = root;
    try {
      let clock = performance.now();
      const runtime = await typstRuntime.init();
      profile('library wasm wait', clock); clock = performance.now();
      await typstRuntime.initFonts();
      profile('library fonts wait', clock); clock = performance.now();
      const vpath = virtualPath(file, root);
      const result = await compileTypstVector(runtime.compiler, vpath, source,
        { loadMissingPackage: typstRuntime.loadMissingPreviewPackage });
      profile('library compile/vector', clock); clock = performance.now();
      const diagnostics = libraryDiagnostics(result.diagnostics, file);
      logTypstDiagnostics(diagnostics, file);
      const id = randomBytes(12).toString('hex');
      const pages = result.artifact
        ? (await pageInfoFromArtifact(runtime.renderer, result.artifact)).map(({ width, height }) => ({ width, height }))
        : [];
      profile('library page info', clock);
      const item = { id, key, file, artifact: result.artifact, info: pages, pages: new Map(), diagnostics,
        outline: parsed.headings, lastUsed: Date.now(), inUse: 0 };
      libraryTypstCache.set(id, item);
      sweepLibraryTypstCache(Date.now(), id);
      return item;
    } finally { typst.root = previousRoot; }
  });
}
async function libraryTypstPage(id, page) {
  const item = libraryTypstCache.get(id);
  if (!item) return json({ error: 'Document expired; reload its metadata' }, 410);
  if (!Number.isInteger(page) || page < 1 || page > item.info.length) return json({ error: 'Page unavailable' }, 404);
  item.lastUsed = Date.now();
  item.inUse++;
  try {
    let svg = item.pages.get(page);
    if (!svg) {
      try {
        const clock = performance.now();
        const full = await pageSvg(typstRuntime.value, item.artifact, item.info, page - 1);
        const pageText = extractSvgPage(full, page)?.svg;
        if (!pageText) return json({ error: 'Page SVG unavailable' }, 500);
        svg = prepareInlineSvg(pageText, `library-${id}-${page}`);
        item.pages.set(page, svg);
        profile(`library svg page ${page}`, clock);
      } catch (error) { return json({ error: error.message }, 500); }
    }
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' } });
  } finally { item.inUse--; item.lastUsed = Date.now(); }
}
function isDocumentActive(file) {
  return libraryViewers.has(pathKey(file)) || [defaultSession, ...sessions.values()]
    .some(session => session.activeDocuments.typst && pathKey(session.activeDocuments.typst.file) === pathKey(file));
}
function sweepLibraryTypstCache(now = Date.now(), protectedId = null) {
  for (const item of libraryTypstCache.values()) {
    if (item.inUse || isDocumentActive(item.file)) continue;
    const idle = now - item.lastUsed;
    if (idle >= PAGE_IDLE_MS) item.pages.clear();
    if (idle >= DOCUMENT_IDLE_MS) libraryTypstCache.delete(item.id);
  }
  if (libraryTypstCache.size <= 3) return;
  const evictable = [...libraryTypstCache.values()]
    .filter(item => item.id !== protectedId && !item.inUse && !isDocumentActive(item.file))
    .sort((a, b) => a.lastUsed - b.lastUsed);
  for (const item of evictable) {
    if (libraryTypstCache.size <= 3) break;
    libraryTypstCache.delete(item.id);
  }
}
const libraryRoutes = createLibraryRoutes({
  root: serviceRoot,
  dist: libraryDist,
  checkedPath: checkedDocumentPath,
  json,
  renderMarkdown,
  compileTypst: compileLibraryTypst,
  typstPage: libraryTypstPage,
  onViewerChange(file, connected) {
    const key = pathKey(file);
    const count = (libraryViewers.get(key) || 0) + (connected ? 1 : -1);
    if (count > 0) libraryViewers.set(key, count);
    else libraryViewers.delete(key);
  },
});
function typstState() {
  const title = basename(typst.file) || 'Typst Preview';
  return { document: typst.file, version: typst.version, title,
    cursor_line: typst.line, count: typst.pages.length, files: typst.pages, sizes: typst.sizes,
    cursor: positionForLine(typst.line, typst.anchors, typst.sizes),
    outline: typst.outline, diagnostics: visibleTypstDiagnostics(typst.diagnostics), math_font_fallback: typst.mathFontFallback };
}
function sourceLineForJump(data) {
  if (Number.isInteger(data.line)) {
    return data.line >= 1 && data.line <= typst.text.split('\n').length ? data.line : undefined;
  }
  const xFraction = data.x ?? 0.5;
  if (!Number.isInteger(data.page) || !Number.isFinite(xFraction) || !Number.isFinite(data.y)
    || xFraction < 0 || xFraction > 1 || data.y < 0 || data.y > 1 || !typst.pages[data.page - 1]) return;
  const size = typst.sizes[data.page - 1];
  const anchorLine = lineForPosition(data.page, data.y, typst.anchors, typst.sizes);
  if (anchorLine) return anchorLine;
  const x = xFraction * size.width, y = data.y * size.height;
  const hits = typst.textHits.filter(hit => hit.page === data.page);
  const hit = hits.reduce((nearest, item) => {
    const distance = (item.x - x) ** 2 + (item.y - y) ** 2;
    return !nearest || distance < nearest.distance ? { line: item.line, distance } : nearest;
  }, null);
  return hit?.line;
}

function textResponse(value, status = 200) { return new Response(value, { status }); }
function protectedResponse(response) {
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}
async function typstAsset(url) {
  const asset = new URL(url.searchParams.get('p') || '', 'http://127.0.0.1');
  const page = Number(asset.pathname.match(/^\/asset\/page-(\d+)\.svg$/)?.[1]);
  const current = typst;
  if (!page || !current.pageInfo[page - 1] || asset.searchParams.get('v') !== String(current.version))
    return json({ error: 'asset not found' }, 404);
  if (!current.svgPages[page - 1]) {
    let pending = current.svgPending[page - 1];
    if (!pending) {
      pending = (async () => {
        const svg = await pageSvg(typstRuntime.value, current.artifact, current.pageInfo, page - 1);
        const pageSvgText = extractSvgPage(svg, page)?.svg;
        if (!pageSvgText) return;
        const offset = current.pageInfo.slice(0, page - 1).reduce((sum, item) => sum + item.height, 0);
        if (neovim.connected()) {
          current.textHits.push(...textHitsFromPages([{ svg: pageSvgText }], current.text)
            .map(hit => ({ ...hit, page, y: hit.y - offset })));
        }
        current.svgPages[page - 1] = prepareInlineSvg(pageSvgText, `v${current.version}-p${page}`);
      })();
      current.svgPending[page - 1] = pending;
    }
    try { await pending; }
    finally { if (current.svgPending[page - 1] === pending) current.svgPending[page - 1] = null; }
  }
  if (current !== typst) return json({ error: 'asset not found' }, 404);
  if (!current.svgPages[page - 1]) return json({ error: 'page SVG missing' }, 500);
  return new Response(current.svgPages[page - 1], { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' } });
}

const app = new Hono();
app.use('*', async (context, next) => {
  const request = context.req.raw;
  const url = new URL(request.url);
  const id = request.headers.get('x-preview-session') || url.searchParams.get('session') || 'default';
  const session = getSession(id, url.pathname === '/__control' && request.method === 'POST');
  if (!session) return protectedResponse(textResponse('Unknown preview session', 404));
  return sessionContext.run(session, async () => {
    try {
      await next();
      return protectedResponse(context.res);
    } catch (error) {
      emit({ event: 'notice', message: error.message });
      return protectedResponse(textResponse('Internal Server Error', 500));
    }
  });
});

app.post('/__control', context => handleControl(context.req.raw));
for (const kind of ['markdown', 'typst']) {
  app.get(`/${kind}`, context => {
    const target = new URL(context.req.url);
    target.pathname += '/';
    return new Response(null, { status: 302, headers: { location: target.href } });
  });
}
app.get('/markdown/__live/events', context => streamRoute('markdown', context));
app.get('/typst/__live/events', context => streamRoute('typst', context));
app.get('/markdown/', async () => {
  try { return new Response(await markdownPreview.page(), { headers: { 'content-type': 'text/html; charset=UTF-8', 'cache-control': 'no-store' } }); }
  catch (error) { return json({ error: error.message }, 500); }
});
app.get('/markdown/document', () => json(markdownPreview.state()));
app.get('/markdown/__live/asset', context => markdownPreview.asset(new URL(context.req.url)));
app.get('/markdown/__live/event', context => {
  const url = new URL(context.req.url);
  let data;
  try {
    data = JSON.parse(url.searchParams.get('data') || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid event');
  } catch { return textResponse('Invalid event', 400); }
  markdownPreview.browserEvent(url.searchParams.get('event'), data);
  return textResponse('ok');
});
app.get('/typst/', async () => {
  try {
    return await fileResponse(resolve(dist, 'src/typst/index.html'), { 'cache-control': 'no-store' })
      || json({ error: 'Typst preview page is missing' }, 500);
  } catch (error) { return json({ error: error.message }, 500); }
});
app.get('/typst/state', () => json(typstState()));
app.get('/typst/__live/asset', context => typstAsset(new URL(context.req.url)));
app.get('/typst/__live/event', context => {
  const url = new URL(context.req.url);
  const event = url.searchParams.get('event');
  let data;
  try { data = JSON.parse(url.searchParams.get('data') || '{}'); }
  catch { return textResponse('Invalid event', 400); }
  if (event === 'source-jump' || event === 'click' || event === 'outline-jump') {
    if (data.document !== typst.file || data.version !== typst.version
      || !typst.pages.length || typst.diagnostics.some(item => item.severity === 'error'))
      return textResponse('Stale preview jump', 409);
    const line = sourceLineForJump(data);
    if (!line) return textResponse('No source location', 409);
    emit({ event: 'jump', kind: 'typst', file: typst.file, buffer: typst.buffer,
      revision: typst.revision, line });
    return textResponse('ok');
  }
  if (event === 'theme-change' && ['dark', 'light'].includes(data.theme))
    emit({ event: 'theme', kind: 'typst', theme: data.theme, file: typst.file });
  return textResponse('ok');
});
app.get('/assets/*', serveStatic({ root: dist }));
app.route('/', libraryRoutes);
app.notFound(() => textResponse('Not found', 404));
const listenPort = Number(process.env.NODE_PREVIEW_PORT || 49191);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)
  throw new Error('NODE_PREVIEW_PORT must be an integer from 1 to 65535');
httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: listenPort });
await new Promise(resolve => httpServer.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
emit({ event: 'ready', baseUrl, root: serviceRoot,
  urls: { markdown: `${baseUrl}/markdown/`, typst: `${baseUrl}/typst/` } });
if (process.env.WASM_PREWARM !== '0' && process.env.TYPST_WASM_PREWARM !== '0') {
  const clock = performance.now();
  void typstRuntime.init().then(() => profile('startup typst wasm', clock))
    .catch(error => emit({ event: 'notice', kind: 'typst', message: `Typst WASM prewarm failed: ${error}` }));
  void prewarmPdfEngine().then(() => profile('startup pdfium wasm', clock))
    .catch(error => emit({ event: 'notice', kind: 'pdf', message: `PDFium WASM prewarm failed: ${error}` }));
}
const resourceSweep = setInterval(() => {
  sweepLibraryTypstCache();
  void sweepPdfDocuments(isDocumentActive, Date.now(), DOCUMENT_IDLE_MS)
    .catch(error => emit({ event: 'notice', kind: 'pdf', message: `PDF cleanup failed: ${error}` }));
}, 60_000);
resourceSweep.unref();

const markdownControl = message => markdownPreview.control(message);
function handleTypst(message) {
  if (message.method === 'cursor') {
    typst.line = message.line || 1;
    publish('typst', 'cursor', { document: typst.file, version: typst.version,
      line: typst.line, ...positionForLine(typst.line, typst.anchors, typst.sizes) });
  } else if (['compile', 'warm'].includes(message.method) && message.file && typeof message.text === 'string') {
    if (message.kind !== 'typst') return;
    const sameActive = currentSession().activeCompile?.epoch === currentSession().typstEpoch
      && pathKey(currentSession().activeCompile.message.file) === pathKey(message.file)
      && currentSession().activeCompile.message.text === message.text
      && currentSession().activeCompile.message.revision === message.revision;
    if (!sameActive) currentSession().typstEpoch++;
    currentSession().pendingCompile = { message, epoch: currentSession().typstEpoch };
    void drainTypstCompiles();
  }
}
function previewUrl(kind) {
  const document = activeDocuments[kind];
  const root = currentSession().root || serviceRoot;
  const path = document ? relative(root, document.file).split(sep).join('/') : '';
  return `${baseUrl}/${kind}/?path=${encodeURIComponent(path)}&session=${encodeURIComponent(currentSession().id || 'default')}`;
}
function clearFileWatch(kind) {
  if (fileWatchers[kind]) { fileWatchers[kind].close(); fileWatchers[kind] = null; }
  if (watchTimers[kind]) { clearTimeout(watchTimers[kind]); watchTimers[kind] = null; }
}
function watchActiveFile(kind, file) {
  clearFileWatch(kind);
  fileWatchers[kind] = watchFile(dirname(file), (_event, changed) => {
    const active = activeDocuments[kind];
    if (!active) return;
    if (changed) {
      const name = Buffer.isBuffer(changed) ? changed.toString() : String(changed);
      if (process.platform === 'win32' ? name.toLowerCase() !== basename(active.file).toLowerCase()
        : name !== basename(active.file)) return;
    }
    if (watchTimers[kind]) clearTimeout(watchTimers[kind]);
    watchTimers[kind] = setTimeout(() => { watchTimers[kind] = null; void refreshActiveFile(kind); }, 120);
  });
  fileWatchers[kind].on('error', error => emit({ event: 'notice', kind, message: `File watch failed: ${error.message}` }));
}
async function refreshActiveFile(kind, method = 'refresh') {
  const current = activeDocuments[kind];
  if (!current || closing) return;
  try {
    const text = await readFile(current.file, 'utf8');
    if (activeDocuments[kind] !== current) return;
    const message = { ...current, text, method: current.kind === 'typst' ? 'compile' : method };
    if (current.kind === 'markdown') await markdownControl(message);
    else handleTypst({ ...message, method: 'compile' });
  } catch (error) {
    emit({ event: 'notice', kind: current.kind, message: `Could not read ${current.file}: ${error.message}` });
  }
}
async function handleControl(request) {
  let message;
  try { message = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return json({ error: 'Invalid request' }, 400);
    if (message.callbackUrl !== undefined) {
    if (typeof message.callbackUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(message.callbackUrl))
      return json({ error: 'Callback must use a loopback HTTP URL' }, 400);
    neovim.setCallback(currentSession().id, message.callbackUrl.endsWith('/') ? message.callbackUrl : `${message.callbackUrl}/`);
  }
  if (message.cwd) {
    let cwd;
    try { cwd = realpathSync(message.cwd); }
    catch { return json({ error: 'Neovim working directory does not exist' }, 400); }
    const currentRoot = currentSession().root;
    if (currentRoot && (process.platform === 'win32' ? cwd.toLowerCase() !== currentRoot.toLowerCase() : cwd !== currentRoot))
      return json({ error: `Preview session root is ${currentRoot}; current working directory is ${cwd}` }, 409);
    currentSession().root = cwd;
  }
  try {
    if (['open', 'activate'].includes(message.method)) {
      if (message.kind !== 'markdown' && message.kind !== 'typst')
        return json({ error: 'Preview kind must be markdown or typst' }, 400);
      const file = checkedDocumentPath(message.file, currentSession().root || serviceRoot);
      const ext = extname(file).toLowerCase();
      if ((message.kind === 'markdown' && ext !== '.md') || (message.kind === 'typst' && ext !== '.typ'))
        return json({ error: 'File type does not match preview kind' }, 400);
      if (!existsSync(file)) return json({ error: 'Preview file does not exist' }, 404);
      const active = activeDocuments[message.kind];
      const switched = !active || pathKey(active.file) !== pathKey(file);
      activeDocuments[message.kind] = { ...message, file, cwd: currentSession().root || serviceRoot, revision: message.revision ?? 0 };
      if (switched) watchActiveFile(message.kind, file);
      await refreshActiveFile(message.kind, message.method === 'open' || switched ? 'open' : 'activate');
      if (message.method === 'open' || switched) emit({ event: 'open', kind: message.kind, url: previewUrl(message.kind) });
      return json({ ok: true, root: currentSession().root || serviceRoot, url: previewUrl(message.kind) });
    }
    if (message.method === 'cursor' || message.method === 'dirty' || message.method === 'focus') {
      if (message.kind !== 'markdown' && message.kind !== 'typst')
        return json({ error: 'Preview kind must be markdown or typst' }, 400);
      const active = activeDocuments[message.kind];
      if (message.cwd && !active) return json({ error: 'No active preview' }, 409);
      if (message.file && active && pathKey(message.file) !== pathKey(active.file))
        return json({ error: 'Preview file is not the active file' }, 409);
      if (message.method === 'cursor') {
        if (message.kind === 'markdown') await markdownControl(message);
        else handleTypst(message);
      } else if (message.method === 'dirty' && message.kind === 'markdown' && markdownPreview.document) {
        await markdownControl(message);
      } else if (message.method === 'focus' && active) {
        emit({ event: 'open', kind: message.kind, url: previewUrl(message.kind) });
      }
      return json({ ok: true });
    }
    if (message.method === 'prewarm' && message.kind === 'typst') {
      const clock = performance.now();
      typstRuntime.init().then(() => profile('prewarm typst wasm', clock))
        .catch(error => emit({ event: 'notice', kind: 'typst', message: `Typst WASM prewarm failed: ${error}` }));
      return json({ ok: true });
    }
    if (message.method === 'warm' && message.kind === 'typst') {
      const file = checkedDocumentPath(message.file, currentSession().root || serviceRoot);
      if (extname(file).toLowerCase() !== '.typ') return json({ error: 'File type does not match preview kind' }, 400);
      const text = await readFile(file, 'utf8');
      handleTypst({ ...message, file, text, method: 'warm' });
      return json({ ok: true });
    }
    if (message.method === 'stop') {
      if (message.kind === 'markdown' || message.kind === 'typst') {
        clearFileWatch(message.kind);
        activeDocuments[message.kind] = null;
      }
      handleMessage(message);
      return json({ ok: true });
    }
    if (message.method === 'detach') {
      const session = currentSession();
      neovim.detach(session.id);
      session.typstEpoch++;
      session.pendingCompile = null;
      session.completedTypst = null;
      for (const kind of ['markdown', 'typst']) {
        if (session.fileWatchers[kind]) { session.fileWatchers[kind].close(); session.fileWatchers[kind] = null; }
        if (session.watchTimers[kind]) { clearTimeout(session.watchTimers[kind]); session.watchTimers[kind] = null; }
        session.activeDocuments[kind] = null;
        const clients = [...session.streams[kind]];
        void Promise.all(clients.map(client => client.write(kind === 'typst' ? 'typst-watch-close' : 'markdown-preview-close', {})
          .catch(() => {}))).finally(() => clients.forEach(client => client.close()));
      }
      session.markdownPreview.stop();
      session.markdownPreview = createMarkdownPreview({ dist, json, emit, publish, renderMarkdown });
      sessions.delete(session.id);
      return json({ ok: true });
    }
    if (message.method === 'shutdown') {
      setTimeout(() => void shutdown(), 30);
      return json({ ok: true });
    }
    return json({ error: `Unknown control method: ${message.method}` }, 400);
  } catch (error) {
    return json({ error: error.code === 'ENOENT' ? 'Preview file does not exist' : error.message }, error.code === 'ENOENT' ? 404 : 400);
  }
}
async function drainTypstCompiles() {
  if (currentSession().compileRunning) return;
  currentSession().compileRunning = true;
  try {
    while (currentSession().pendingCompile && !closing) {
      const task = currentSession().pendingCompile;
      currentSession().pendingCompile = null;
      currentSession().activeCompile = task;
      const { message, epoch } = task;
      try {
        if (currentSession().completedTypst?.file === resolve(message.file) && currentSession().completedTypst.text === message.text
          && currentSession().completedTypst.revision === message.revision && typst.pages.length) {
          if (message.method === 'compile') {
            typst.line = message.line || 1;
            typst.buffer = message.buffer;
            emitTypstDiagnostics(message);
            await publish('typst', 'refresh');
          }
        } else await withTypstLock(() => compileTypst(message, epoch));
      } catch (error) {
        if (epoch !== currentSession().typstEpoch) continue;
        await failTypst(message, message.file, [{ severity: 'error', message: String(error) }]);
      }
    }
  } finally {
    currentSession().activeCompile = null;
    currentSession().compileRunning = false;
  }
}
function handleMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.method === 'shutdown') return shutdown();
  if (message.method === 'prewarm' && message.kind === 'typst') {
    const clock = performance.now();
    typstRuntime.init().then(() => profile('prewarm typst wasm', clock))
      .catch(error => emit({ event: 'notice', kind: 'typst', message: `Typst WASM prewarm failed: ${error}` }));
    return;
  }
  if (message.method === 'stop') {
    if (message.kind === 'markdown') {
      publish('markdown', 'markdown-preview-close').finally(() => streams.markdown.forEach(client => client.close()));
      markdownPreview.stop();
    } else if (message.kind === 'typst') {
      currentSession().typstEpoch++;
      currentSession().pendingCompile = null;
      currentSession().completedTypst = null;
      publish('typst', 'typst-watch-close').finally(() => streams.typst.forEach(client => client.close()));
      currentSession().typst = { ...typst, ...emptyTypstOutput(), file: '', text: '', diagnostics: [], version: typst.version + 1 };
    }
    emit({ event: 'stopped', kind: message.kind });
    return;
  }
  if (message.kind === 'markdown') markdownControl(message);
  else if (message.kind === 'typst') handleTypst(message);
}
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(resourceSweep);
  const allSessions = [defaultSession, ...sessions.values()];
  await Promise.all(allSessions.map(async session => sessionContext.run(session, async () => {
    session.typstEpoch++;
    session.pendingCompile = null;
    await Promise.all([publish('markdown', 'markdown-preview-close'), publish('typst', 'typst-watch-close')]);
    for (const clients of Object.values(session.streams)) clients.forEach(client => client.close());
    for (const kind of ['markdown', 'typst']) clearFileWatch(kind);
    session.markdownPreview.stop();
  })));
  // Allow close events to reach SSE clients before closing the listener.
  await new Promise(resolve => setTimeout(resolve, 150));
  httpServer.closeAllConnections();
  httpServer.close();
  process.exit(0);
}

// Keep accepting the former JSON-lines protocol for existing automation while
// Neovim itself uses the HTTP control endpoint.
async function readLegacyMessages() {
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for await (const chunk of process.stdin) {
      pending += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) {
          try { handleMessage(JSON.parse(line)); }
          catch (error) { emit({ event: 'notice', message: String(error) }); }
        }
      }
    }
  } catch (error) { emit({ event: 'notice', message: String(error) }); }
}
void readLegacyMessages();
