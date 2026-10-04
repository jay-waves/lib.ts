import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { openRepositories } from '../library/repositories.mjs';
import { createLibraryOpenRoutes } from '../library/open-routes.mjs';

test('external opening reuses one existing library, prefers its repo and falls back after disconnect', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'library-open-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = resolve(temporary, '中文 notes'), second = resolve(temporary, 'other');
  await mkdir(first); await mkdir(second);
  await writeFile(resolve(first, 'a #.md'), '# First');
  await writeFile(resolve(second, 'b.md'), '# Second');
  const repositories = await openRepositories(resolve(temporary, 'data'));
  const a = await repositories.add(first), b = await repositories.add(second);
  const routes = createLibraryOpenRoutes({ repositories, defaultRepo: a,
    json: (value, status = 200) => Response.json(value, { status }),
    checkedPath(path, root) {
      const file = realpathSync(resolve(root, path)), rel = relative(root, file);
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('Outside repo');
      return file;
    } });
  t.after(() => routes.close());
  const post = (body, url = '/api/library/open') => routes.app.request(url, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const request = { repo: a.slug, path: 'a #.md', line: 2, view: 'preview' };
  const fallback = await (await post(request)).json();
  assert.equal(fallback.reused, false);
  assert.equal(fallback.url, `/${encodeURIComponent(a.slug)}/tree/a%20%23.md?line=2&view=preview`);
  const connect = async (client, repo) => {
    const response = await routes.app.request(`/api/library/session?${new URLSearchParams({ client, repo })}`);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/);
    return reader;
  };
  const one = await connect('client-first-123456', a.slug);
  const two = await connect('client-second-12345', b.slug);
  await post({ client: 'client-second-12345' }, '/api/library/activity');
  const open = post(request);
  assert.match(new TextDecoder().decode((await one.read()).value), /"path":"a #.md"/);
  assert.equal((await (await open).json()).reused, true);
  await one.cancel();
  const crossRepo = post({ file: resolve(first, 'a #.md') });
  const crossResponse = await crossRepo;
  const crossBody = await crossResponse.json();
  assert.equal(crossResponse.status, 200, JSON.stringify(crossBody));
  assert.equal(crossBody.reused, true);
  assert.match(new TextDecoder().decode((await two.read()).value), /event: document-open/);
  await two.cancel();
  assert.equal((await (await post(request)).json()).reused, false);
  assert.equal((await post({ repo: a.slug, path: '../other/b.md' })).status, 400);
  assert.equal((await post({ repo: a.slug, path: 'a #.md', line: -1 })).status, 400);
  assert.equal((await post({ file: resolve(temporary, 'missing.md') })).status, 404);
  const forbidden = await routes.app.request('/api/library/open', { method: 'POST', headers: {
    origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(forbidden.status, 403);
});
