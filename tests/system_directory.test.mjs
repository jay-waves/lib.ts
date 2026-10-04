import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepositoryRoutes } from '../library/repo-routes.mjs';

test('system directory opening resolves repo folders and rejects invalid or cross-origin requests', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'system-directory-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = resolve(temporary, 'repo');
  await mkdir(resolve(root, '中文 folder'), { recursive: true });
  await writeFile(resolve(root, 'note.md'), 'hello');
  const repo = { id: 'repo', slug: 'repo', root: realpathSync(root) }, opened = [];
  const app = createRepositoryRoutes({
    repositories: { find: id => id === 'repo' ? repo : null }, defaultRepo: repo,
    dist: temporary, json: (body, status = 200) => Response.json(body, { status }),
    checkedPath(path, base) {
      if (!path || path.includes('\0')) throw new Error('Invalid path');
      const target = realpathSync(resolve(base, path)), rel = relative(base, target);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Outside repository');
      return target;
    },
    openSystemDirectory: async directory => opened.push(directory),
  });
  const post = (path, url = `/${repo.slug}/api/open-directory`, headers = {}) => app.request(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ path }),
  });
  assert.equal((await post('')).status, 200);
  assert.equal(opened[0], repo.root);
  assert.equal((await post('中文 folder', `/${repo.slug}/api/open-directory`)).status, 200);
  assert.equal(opened[1], realpathSync(resolve(root, '中文 folder')));
  assert.equal((await post('note.md')).status, 400);
  assert.equal((await post('..')).status, 400);
  assert.equal((await post('missing')).status, 404);
  assert.equal((await post('bad\0path')).status, 400);
  assert.equal((await post('', '/unknown/api/open-directory')).status, 404);
  assert.equal((await post('', `/${repo.slug}/api/open-directory`, { origin: 'https://example.com' })).status, 403);
  assert.equal(opened.length, 2);
});

import { EventEmitter } from 'node:events';
import { openSystemDirectory } from '../library/system-directory.mjs';

test('Windows explorer launches visibly with normalized paths and no shell', async () => {
  let invocation;
  const child = new EventEmitter();
  child.unref = () => {};
  const result = openSystemDirectory('E:/中文 folder/a & b/', {
    platform: 'win32', env: { SystemRoot: 'C:/Windows' },
    launch: (...args) => { invocation = args; return child; },
  });
  child.emit('spawn'); child.emit('exit', 1);
  await result;
  assert.equal(invocation[0], 'C:\\Windows\\explorer.exe');
  assert.deepEqual(invocation[1], ['E:\\中文 folder\\a & b\\']);
  assert.deepEqual(invocation[2], { shell: false, windowsHide: false, stdio: 'ignore' });
});

test('launcher errors and unsuccessful process exits propagate to the directory endpoint', async () => {
  for (const failure of ['error', 'exit']) {
    const child = new EventEmitter();
    const result = openSystemDirectory('/notes', {
      platform: 'linux', launch: () => child,
    });
    if (failure === 'error') child.emit('error', new Error('Cannot launch file manager'));
    else { child.emit('spawn'); child.emit('exit', 2); }
    await assert.rejects(result, /Cannot launch|failed to open/);
  }
});
