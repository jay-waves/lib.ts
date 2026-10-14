import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createSessionLeases } from '../server/session-leases.mjs';
import { createLibraryRoutes } from '../server/routes.mjs';
import { sweepTypstCache } from '../server/typst/cache.mjs';
import { observePageWindow } from '../web/page-window.mjs';

test('retained document leases renew without duplicate references, release on repo exit and expire after a crash', () => {
  let now = 0;
  const counts = new Map();
  const leases = createSessionLeases((file, active) => counts.set(file, (counts.get(file) || 0) + (active ? 1 : -1)), { now: () => now, ttl: 90 });
  leases.update('window-a', ['a.typ', 'b.pdf', 'a.typ']);
  leases.update('window-a', ['a.typ', 'b.pdf']);
  assert.equal(counts.get('a.typ'), 1);
  leases.update('window-b', ['a.typ']);
  leases.update('window-a', []);
  assert.equal(counts.get('a.typ'), 1); assert.equal(counts.get('b.pdf'), 0);
  now = 80; leases.update('window-b', ['a.typ']);
  now = 100; leases.sweep(); assert.equal(counts.get('a.typ'), 1);
  now = 170; leases.sweep(); assert.equal(counts.get('a.typ'), 0);
  leases.sweep(); assert.equal(counts.get('a.typ'), 0);
});

test('multiple retained Typst artifacts survive idle/count eviction until their lease ends', () => {
  const active = new Set();
  const leases = createSessionLeases((file, retained) => retained ? active.add(file) : active.delete(file));
  const files = Array.from({ length: 6 }, (_, i) => `${i}.typ`);
  const cache = new Map(files.map(file => [file, { id: file, file, lastUsed: 0, inUse: 0 }]));
  leases.update('tabs', files);
  sweepTypstCache(cache, { now: 1000000, isActive: file => active.has(file), fileKey: file => file });
  assert.equal(cache.size, 6);
  leases.update('tabs', []);
  sweepTypstCache(cache, { now: 1000000, isActive: file => active.has(file), fileKey: file => file });
  assert.equal(cache.size, 0);
});

test('retention API validates the whole batch before changing resource ownership', async () => {
  const changes = [];
  const app = createLibraryRoutes({ root: resolve('notes'), json: (value, status = 200) => Response.json(value, { status }),
    checkedPath: path => { if (path.startsWith('../')) throw new Error('Outside repository'); return path; },
    onViewerChange: (file, active) => changes.push([file, active]) });
  const send = (body, origin) => app.request('/api/library/session-leases', { method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  assert.equal((await send({ client: 'tabs', paths: ['a.typ', '../bad'] })).status, 400);
  assert.deepEqual(changes, []);
  assert.equal((await send({ client: 'tabs', paths: ['a.typ', 'b.pdf'] })).status, 200);
  assert.equal((await send({ client: 'tabs', paths: ['a.typ', 'b.pdf'] })).status, 200);
  assert.deepEqual(changes, [['a.typ', true], ['b.pdf', true]]);
  assert.equal((await send({ client: 'tabs', paths: [] }, 'https://foreign.example')).status, 403);
  assert.equal((await send({ client: 'tabs', paths: [] })).status, 200);
  assert.deepEqual(changes.slice(2), [['a.typ', false], ['b.pdf', false]]);
});

test('resuming a retained PDF/Typst viewport keeps its current page window rather than loading the first pages', () => {
  const initial = { first: 298, last: 302 }, notifications = [];
  class Observer { observe() {} disconnect() {} }
  const stop = observePageWindow({ closest: () => ({}), querySelectorAll: () => [] }, 400,
    window => notifications.push(window), Observer, initial);
  assert.deepEqual(notifications, [initial]); stop();
});

test('a late heartbeat cannot reacquire a lease after a newer repo-exit release', () => {
  const changes = [];
  const leases = createSessionLeases((file, active) => changes.push([file, active]));
  leases.update('client', ['a.typ'], 1);
  leases.update('client', [], 3);
  leases.update('client', ['a.typ'], 2);
  assert.deepEqual(changes, [['a.typ', true], ['a.typ', false]]);
  leases.update('client', ['b.pdf'], 4);
  assert.deepEqual(changes.at(-1), ['b.pdf', true]);
});

test('deleted tabs do not prevent the remaining document leases from renewing', async () => {
  const changes = [];
  const app = createLibraryRoutes({ root: resolve('notes'), json: (value, status = 200) => Response.json(value, { status }),
    checkedPath: path => { if (path === 'gone.typ') throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return path; },
    onViewerChange: (file, active) => changes.push([file, active]) });
  const send = paths => app.request('/api/library/session-leases', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'client', paths }) });
  assert.equal((await send(['gone.typ', 'book.pdf'])).status, 200);
  assert.deepEqual(changes, [['book.pdf', true]]);
  await send([]);
});

test('closing repository routes releases outstanding document leases exactly once', async () => {
  const changes = [];
  const app = createLibraryRoutes({ root: resolve('notes'),
    json: (value, status = 200) => Response.json(value, { status }), checkedPath: path => path,
    onViewerChange: (file, active) => changes.push([file, active]) });
  await app.request('/api/library/session-leases', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'closing', paths: ['book.pdf'], version: 1 }) });
  app.close(); app.close();
  assert.deepEqual(changes, [['book.pdf', true], ['book.pdf', false]]);
});
