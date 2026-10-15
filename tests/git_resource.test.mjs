import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitResource } from '../web/git-resource.ts';

test('polling is shared, pauses while hidden and preserves the last result on failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new EventTarget(); document.hidden = false;
  const window = new EventTarget();
  let calls = 0, fail = false;
  const resource = createGitResource('/status', { document, window, interval: 100,
    fetch: async () => {
      calls++;
      if (fail) throw new Error('offline');
      return new Response(JSON.stringify({ repository: true, branch: 'main', changes: [{ path: `${calls}.md`, status: '.M' }] }),
        { headers: { 'content-type': 'application/json' } });
    } });
  const release1 = resource.retain(), release2 = resource.retain();
  t.after(() => { release1(); release2(); });
  await resource.refresh();
  assert.equal(calls, 1);
  t.mock.timers.tick(100);
  await resource.refresh();
  assert.equal(calls, 2);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await resource.refresh();
  assert.equal(calls, 3);
  fail = true;
  await resource.refresh(true);
  assert.deepEqual(resource.getSnapshot().status.changes, [{ path: '3.md', status: '.M' }]);
  assert.equal(resource.getSnapshot().error, 'offline');
});
