import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPlaybackRate, stepPlaybackRate } from './video-playback.ts';

test('mpv bracket speed changes are multiplicative and reversible', () => {
  assert.equal(stepPlaybackRate(1, 1), 1.1);
  assert.equal(stepPlaybackRate(1.1, -1), 1);
  assert.equal(stepPlaybackRate(0.75, 1), 0.825);
});

test('repeated speed shortcuts stay within browser playback limits', () => {
  let slow = 1, fast = 1;
  for (let i = 0; i < 100; i++) {
    slow = stepPlaybackRate(slow, -1);
    fast = stepPlaybackRate(fast, 1);
  }
  assert.equal(slow, 0.25);
  assert.equal(fast, 4);
  assert.equal(formatPlaybackRate(1.2100000000000002), '1.21×');
});
