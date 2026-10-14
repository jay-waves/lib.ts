import test from 'node:test';
import assert from 'node:assert/strict';
import { initialImageScale } from '../web/document-preview.mjs';

test('images start at native size with a maximum of 80% of viewport width', () => {
  assert.equal(initialImageScale(200, 1000), 1);
  assert.equal(initialImageScale(800, 1000), 1);
  assert.equal(initialImageScale(1600, 1000), .5);
  assert.equal(initialImageScale(10000, 500), .04);
  assert.equal(initialImageScale(0, 1000), 1);
});
