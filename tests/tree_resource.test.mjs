import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeResource } from '../library/tree-resource.mjs';

const tree = (...paths) => ({ children: paths.map(path => ({ path, type: 'file' })) });

test('known paths reuse the tree and concurrent unknown paths share a scan', async () => {
  let calls = 0;
  const resource = createTreeResource(async () => { calls++; return tree('a.md'); });
  await resource.ensure('a.md');
  await Promise.all(Array.from({ length: 100 }, () => resource.ensure('a.md')));
  assert.equal(calls, 1);
  await Promise.all([resource.ensure('b.md'), resource.ensure('c.md')]);
  assert.equal(calls, 2);
  assert.equal(resource.index.get('a.md').type, 'file');
});

test('a change during a scan triggers a follow-up before publishing the tree', async () => {
  const completions = [];
  const resource = createTreeResource(() => new Promise(resolve => completions.push(resolve)));
  const pending = resource.refresh();
  assert.equal(resource.invalidate(), pending);
  completions[0](tree('old.md'));
  await Promise.resolve();
  assert.equal(completions.length, 2);
  completions[1](tree('new.md'));
  await pending;
  assert.equal(resource.has('old.md'), false);
  assert.equal(resource.has('new.md'), true);
});

test('disposing aborts stale requests and a new request can succeed', async () => {
  let finish, signal;
  const resource = createTreeResource(s => { signal = s; return new Promise(resolve => { finish = resolve; }); });
  const pending = resource.refresh();
  resource.dispose();
  assert.equal(signal.aborted, true);
  finish(tree('old.md'));
  await assert.rejects(pending, { name: 'AbortError' });
  const next = resource.refresh();
  finish(tree('new.md'));
  await next;
  assert.equal(resource.has('new.md'), true);
});
