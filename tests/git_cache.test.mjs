import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitStatusCache } from '../library/git-cache.mjs';

test('tabs share in-flight status and cached results, while repositories remain independent', async () => {
  let calls = 0, time = 0, finish;
  const read = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const status = createGitStatusCache({ read, now: () => time, ttl: 100 });
  const first = status('repo-a'), second = status('repo-a');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ changes: [] });
  await first;
  await status('repo-a');
  assert.equal(calls, 1);
  time = 101;
  const expired = status('repo-a');
  await Promise.resolve(); finish({ changes: ['new'] });
  assert.deepEqual((await expired).changes, ['new']);
  const other = status('repo-b');
  await Promise.resolve(); finish({ changes: ['other'] });
  assert.deepEqual((await other).changes, ['other']);
  assert.equal(calls, 3);
  const forced = status('repo-a', { force: true });
  assert.equal(status('repo-a', { force: true }), forced);
  await Promise.resolve(); finish({ changes: [] }); await forced;
  assert.equal(calls, 4);
});

test('failed shared queries can be retried', async () => {
  let calls = 0;
  const status = createGitStatusCache({ read: async () => {
    if (++calls === 1) throw new Error('unavailable');
    return { changes: [] };
  } });
  await assert.rejects(status('repo'), /unavailable/);
  assert.deepEqual(await status('repo'), { changes: [] });
});
