import { createTypstService } from './server/typst/service.mjs';
import { realpathSync } from 'node:fs';
import { resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { createMarkdownService } from './server/markdown/service.mjs';
import { createRepositoryRoutes } from './server/repo-routes.mjs';
import { openRepositories } from './server/repositories.mjs';
import { createPdfService } from './server/pdf/engine.mjs';
import { repositoryUrl } from './shared/paths.mjs';

import { createLibraryOpenRoutes } from './server/open-routes.mjs';
import { openSystemBrowser } from './server/system-browser.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const webDist = resolve(dist, 'web');
const rootArgument = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
const serviceRoot = realpathSync(resolve(rootArgument || process.cwd()));
const dataDirectory = resolve(process.env.LIBRARY_DATA_DIRECTORY || resolve(here, 'data'));
const repositories = await openRepositories(dataDirectory);
const defaultRepo = rootArgument ? await repositories.add(serviceRoot) : repositories.list()[0];
const libraryViewers = new Map();
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

function emit(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function pathKey(file) { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file); }
function profile(stage, start) {
  if ((process.env.TYPST_PROFILE || process.env.TYPST_WASM_PROFILE) === '1') emit({ event: 'profile', stage, ms: Math.round(performance.now() - start) });
}
function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
const typst = createTypstService({ root: serviceRoot, emit, profile, isActive: isDocumentActive });
const pdf = createPdfService({ isActive: isDocumentActive, emit, profile });
const markdown = createMarkdownService({ emit, profile });
function isDocumentActive(file) { return libraryViewers.has(pathKey(file)); }
const libraryRoutes = createRepositoryRoutes({
  repositories, defaultRepo, dataDirectory, initialRoot: serviceRoot,
  dist: webDist,
  checkedPath: checkedLibraryPath,
  json,
  renderMarkdown: markdown.render,
  typst, pdf,
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
const externalOpen = createLibraryOpenRoutes({ repositories, defaultRepo, checkedPath: checkedLibraryPath, json,
  openBrowser: url => openSystemBrowser(new URL(url, baseUrl).href) });
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
const resourceSweep = setInterval(() => {
  typst.sweep();
  void pdf.sweep()
    .catch(error => emit({ event: 'notice', kind: 'pdf', message: `PDF cleanup failed: ${error}` }));
}, 60_000);
resourceSweep.unref();


async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(resourceSweep);
  externalOpen.close();
  await Promise.all([typst.close(), pdf.close(), markdown.close()]);
  httpServer.closeAllConnections();
  httpServer.close();
  try { await libraryRoutes.close(); }
  catch (error) { emit({ event: 'notice', kind: 'reading', message: `Reading state save failed: ${error}` }); }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
