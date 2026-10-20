import test from 'node:test';
import assert from 'node:assert/strict';
import { getFileTree } from '../web/api/library.ts';

test('directory expansion encodes its path and distinguishes unloaded from empty folders', async t => {
  const controller = new AbortController();
  let url, signal;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    url = new URL(input, 'http://localhost'); signal = init.signal;
    return new Response(JSON.stringify({ name: 'repo', absolutePath: '/repo', children: [
      { name: 'unopened', path: 'unopened', type: 'directory', modified: '' },
      { name: 'empty', path: 'empty', type: 'directory', modified: '', children: [] },
    ] }), { headers: { 'content-type': 'application/json', 'x-tree-revision': '12' } });
  });
  const tree = await getFileTree('/repo/api', controller.signal, true, '照片/a & b');
  assert.equal(url.pathname, '/repo/api/tree');
  assert.deepEqual(Object.fromEntries(url.searchParams), { showHidden: 'true', path: '照片/a & b' });
  assert.equal(signal, controller.signal);
  assert.equal(tree.revision, '12');
  assert.equal(tree.children[0].children, undefined);
  assert.deepEqual(tree.children[1].children, []);
});
