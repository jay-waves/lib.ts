import test from 'node:test';
import assert from 'node:assert/strict';
import { createTreeResource } from '../web/tree-resource.ts';

const listing = (path, children, name = path || 'repo') => ({ path, name, absolutePath: `/${path}`, children, revision: '1' });
const directory = path => ({ name: path.split('/').at(-1), path, type: 'directory', modified: '' });
const file = path => ({ name: path.split('/').at(-1), path, type: 'file', modified: '' });

test('same directory requests share one in-flight fetch', async () => {
  let finish, calls = 0;
  const resource = createTreeResource(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  const first = resource.ensureDirectory('');
  const second = resource.ensureDirectory('');
  assert.equal(calls, 1);
  finish(listing('', [directory('docs')]));
  await Promise.all([first, second]);
  assert.equal(resource.index.get('docs').type, 'directory');
});

test('directory responses merge by path and preserve previously loaded branches', async () => {
  const resource = createTreeResource(async (_, path) => path === ''
    ? listing('', [directory('docs'), directory('photos')])
    : path === 'docs' ? listing('docs', [file('docs/note.md')])
      : listing('photos', [file('photos/a.jpg')]));
  await resource.ensureDirectory('');
  await resource.ensureDirectory('docs');
  const docsNode = resource.index.get('docs');
  await resource.ensureDirectory('photos');
  assert.equal(resource.index.get('docs'), docsNode);
  assert.deepEqual(resource.index.get('docs').children.map(node => node.path), ['docs/note.md']);
  assert.deepEqual(resource.index.get('photos').children.map(node => node.path), ['photos/a.jpg']);
});

test('deep navigation loads ancestor listings in order and then the target directory', async () => {
  const calls = [];
  const resource = createTreeResource(async (_, path) => {
    calls.push(path);
    if (!path) return listing('', [directory('docs')]);
    if (path === 'docs') return listing('docs', [directory('docs/deep')]);
    return listing('docs/deep', [file('docs/deep/note.md')]);
  });
  await resource.ensure('docs/deep/note.md');
  assert.deepEqual(calls, ['', 'docs', 'docs/deep']);
  assert.equal(resource.has('docs/deep/note.md'), true);
});

test('disposing aborts active directory requests', async () => {
  let signal, finish;
  const resource = createTreeResource((currentSignal) => {
    signal = currentSignal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = resource.ensureDirectory('');
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  resource.dispose();
  assert.equal(signal.aborted, true);
  finish(listing('', []));
  await cancelled;
});
