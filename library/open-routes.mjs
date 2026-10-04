import { stat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { documentUrl } from './paths.mjs';

export function createLibraryOpenRoutes({ repositories, defaultRepo, checkedPath, json }) {
  const app = new Hono();
  const clients = new Map();
  function mutationError(context) {
    const origin = context.req.header('origin');
    if (origin && origin !== new URL(context.req.url).origin) return json({ error: 'Cross-origin request forbidden' }, 403);
    if (!context.req.header('content-type')?.startsWith('application/json')) return json({ error: 'Expected application/json' }, 415);
  }
  app.get('/api/library/session', context => {
    const id = context.req.query('client');
    const repo = repositories.find(context.req.query('repo') || defaultRepo?.id);
    if (!id || !/^[\w-]{16,80}$/.test(id) || !repo) return json({ error: 'Invalid library client' }, 400);
    clients.get(id)?.close();
    return streamSSE(context, async stream => {
      let finish, timer;
      const ended = new Promise(done => { finish = done; });
      const client = { id, repoId: repo.id, usedAt: Date.now(),
        send: value => stream.writeSSE({ event: 'document-open', data: JSON.stringify(value) }),
        close() {
          clearInterval(timer);
          if (clients.get(id) === client) clients.delete(id);
          finish();
          void stream.close();
        } };
      clients.set(id, client);
      stream.onAbort(() => client.close());
      timer = setInterval(() => { void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => client.close()); }, 15000);
      await stream.writeSSE({ event: 'connected', data: '{}' });
      await ended;
    });
  });
  app.post('/api/library/activity', async context => {
    const error = mutationError(context);
    if (error) return error;
    try {
      const { client: id } = await context.req.json();
      const client = clients.get(id);
      if (client) client.usedAt = Date.now();
      return json({ ok: Boolean(client) });
    } catch { return json({ error: 'Invalid JSON' }, 400); }
  });
  app.post('/api/library/open', async context => {
    const error = mutationError(context);
    if (error) return error;
    try {
      const request = await context.req.json();
      let repo, path;
      if (request.file !== undefined) {
        if (typeof request.file !== 'string' || !isAbsolute(request.file)) throw new Error('file must be an absolute path');
        const file = await realpath(resolve(request.file));
        repo = repositories.list().sort((a, b) => b.root.length - a.root.length).find(item => {
          const rel = relative(item.root, file);
          return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
        });
        if (repo) path = relative(repo.root, file).split(sep).join('/');
      } else {
        repo = repositories.find(request.repo || defaultRepo?.id);
        path = request.path;
      }
      if (!repo) return json({ error: 'File does not belong to a registered repository' }, 404);
      if (typeof path !== 'string' || !path || path.includes('\0')) throw new Error('path is required');
      const file = checkedPath(path, repo.root);
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
      path = relative(repo.root, file).split(sep).join('/');
      if (request.line !== undefined && (!Number.isInteger(request.line) || request.line < 1)) throw new Error('Invalid source line');
      if (request.view !== undefined && !['preview', 'raw'].includes(request.view)) throw new Error('Invalid view');
      const query = new URLSearchParams();
      if (request.line) query.set('line', request.line);
      if (request.view) query.set('view', request.view);
      const url = `${documentUrl(repo, path)}${query.size ? `?${query}` : ''}`;
      const payload = { repo: repo.slug, path, line: request.line || null,
        view: request.view || (request.line ? 'raw' : 'preview'), url };
      const candidates = [...clients.values()].sort((a, b) =>
        Number(b.repoId === repo.id) - Number(a.repoId === repo.id) || b.usedAt - a.usedAt);
      for (const client of candidates) {
        try { await client.send(payload); return json({ reused: true, url }); }
        catch { client.close(); }
      }
      return json({ reused: false, url });
    } catch (error) { return json({ error: error.message }, error.code === 'ENOENT' ? 404 : 400); }
  });
  return { app, close() { for (const client of clients.values()) client.close(); } };
}
