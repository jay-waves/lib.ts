import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeResource } from '../web/tree-resource.ts';

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

test('unopened and empty directories are distinct; only expansions trigger loading', async () => {
  const calls = [];
  const resource = createTreeResource(async (_, path) => {
    calls.push(path);
    return { children: [{ path: 'docs', type: 'directory', ...(path === 'docs' ? { children: [] } : {}) }] };
  });
  await resource.ensure('');
  assert.deepEqual(calls, ['']);
  assert.equal(resource.index.get('docs').children, undefined);
  await resource.ensureDirectory('docs');
  await resource.ensureDirectory('docs');
  assert.deepEqual(calls, ['', 'docs']);
  assert.deepEqual(resource.index.get('docs').children, []);
});

test('deep file navigation requests its parent, not a recursive repository scan', async () => {
  const calls = [];
  const resource = createTreeResource(async (_, path) => {
    calls.push(path);
    return { children: [{ path: 'docs', type: 'directory', children: [
      { path: 'docs/deep', type: 'directory', children: [{ path: 'docs/deep/note.md', type: 'file' }] },
    ] }] };
  });
  await resource.ensure('docs/deep/note.md');
  assert.deepEqual(calls, ['docs/deep']);
  assert.equal(resource.has('docs/deep/note.md'), true);
});

test('queued directories publish incrementally and scan one at a time', async () => {
  const completions = [], calls = [], published = [];
  const resource = createTreeResource((_, path) => {
    calls.push(path);
    return new Promise(resolve => completions.push(resolve));
  });
  const unsubscribe = resource.subscribe(value => published.push(value));
  const first = resource.ensureDirectory('docs');
  const second = resource.ensureDirectory('photos');
  assert.deepEqual(calls, ['docs']);
  completions[0](tree('one.md'));
  await Promise.resolve();
  assert.equal(published.length, 1);
  assert.deepEqual(calls, ['docs', 'photos']);
  completions[1](tree('two.md'));
  await Promise.all([first, second]);
  assert.equal(published.length, 2);
  unsubscribe();
});
