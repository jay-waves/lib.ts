import test from 'node:test';
import assert from 'node:assert/strict';
import { historyFileGroups } from '../library/history-groups.mjs';
import { historyTimeGroup, formatRelativeModified } from '../library/time-labels.mjs';

const now = Date.parse('2026-10-02T12:00:00Z'), day = 86400000;
const date = days => new Date(now - days * day).toISOString();

test('history time buckets have exclusive boundaries and handle unknown and future dates', () => {
  for (const [age, expected] of [[0, 'past-week'], [6.999, 'past-week'], [7, 'past-month'],
    [29.999, 'past-month'], [30, 'past-six-months'], [182.999, 'past-six-months'], [183, 'older'], [1000, 'older'], [-1, 'past-week']])
    assert.equal(historyTimeGroup(date(age), now), expected);
  assert.equal(historyTimeGroup(undefined, now), null); assert.equal(historyTimeGroup('bad date', now), null);
  assert.equal(formatRelativeModified(date(0), now), 'just now');
  assert.equal(formatRelativeModified(date(7), now), '1 week ago');
  assert.equal(formatRelativeModified(date(60), now), 'last month');
});

test('history folders keep each file once, omit empty groups and preserve recent order within groups', () => {
  const paths = ['math/note.md', 'books/note.md', 'old.md', 'month.md', 'unknown.md', 'half.md', 'math/note.md'];
  const dates = { 'math/note.md': date(0), 'books/note.md': date(4), 'month.md': date(10), 'half.md': date(90), 'old.md': date(365) };
  const groups = historyFileGroups(paths, dates, now);
  assert.deepEqual(groups.map(group => group.name), ['Past Week', 'Past Month', 'Past 6 Months', 'Older']);
  assert.ok(groups.every(group => group.type === 'directory' && group.virtual && group.path.startsWith('history:')));
  assert.deepEqual(groups[0].children.map(node => node.path), ['math/note.md', 'books/note.md']);
  assert.ok(groups.flatMap(group => group.children).every(node => node.type === 'file' && !node.children));
  assert.equal(groups.flatMap(group => group.children).length, 5);
  assert.deepEqual(historyFileGroups(), []);
  assert.deepEqual(historyFileGroups(['unknown.md'], {}, now), []);
});
