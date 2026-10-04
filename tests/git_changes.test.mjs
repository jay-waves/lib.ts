import test from 'node:test';
import assert from 'node:assert/strict';
import { groupGitChanges } from '../library/git-changes.mjs';

test('partially staged files appear in both groups with their own status codes', () => {
  const groups = groupGitChanges([
    { path: 'both', status: 'AM' }, { path: 'staged', status: 'D.' },
    { path: 'working', status: '.M' }, { path: 'new', status: '??' },
    { path: 'conflict', status: 'UU' }, { path: 'both-added', status: 'AA' },
  ]);
  assert.deepEqual(groups.map(group => [group.id, group.changes.map(change => [change.path, change.code])]), [
    ['conflict', [['conflict', 'U'], ['both-added', 'U']]],
    ['staged', [['both', 'A'], ['staged', 'D']]],
    ['unstaged', [['both', 'M'], ['working', 'M'], ['new', '?']]],
  ]);
  assert.deepEqual(groupGitChanges([]), []);
});
