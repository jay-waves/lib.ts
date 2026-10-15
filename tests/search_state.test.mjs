import test from 'node:test';
import assert from 'node:assert/strict';
import { initialSearchState, searchReducer } from '../web/search-state.ts';

const page = (searchId, paths, nextOffset = 1) => ({
  searchId, files: paths.map(path => ({ path })), nextOffset,
});

test('search transitions clear previous results and recover from errors', () => {
  let state = searchReducer(initialSearchState, { type: 'search-start' });
  assert.deepEqual(state, { status: 'loading' });
  state = searchReducer(state, { type: 'search-error', error: 'Network error' });
  assert.deepEqual(state, { status: 'error', error: 'Network error' });
  state = searchReducer(state, { type: 'search-success', result: page('new', ['a.ts']) });
  assert.equal(state.status, 'ready');
  assert.deepEqual(searchReducer(state, { type: 'search-start' }), { status: 'loading' });
  assert.deepEqual(searchReducer(state, { type: 'search-idle' }), initialSearchState);
});

test('pagination retains files on failure and appends a successful retry', () => {
  let state = searchReducer(initialSearchState, { type: 'search-success', result: page('current', ['a.ts']) });
  state = searchReducer(state, { type: 'page-start', searchId: 'current' });
  state = searchReducer(state, { type: 'page-error', searchId: 'current', error: 'Expired' });
  assert.equal(state.page.status, 'error');
  assert.equal(state.result.files.length, 1);
  state = searchReducer(state, { type: 'page-start', searchId: 'current' });
  assert.equal(state.page.error, undefined);
  state = searchReducer(state, { type: 'page-success', searchId: 'current', result: page('current', ['b.ts'], null) });
  assert.deepEqual(state.result.files.map(file => file.path), ['a.ts', 'b.ts']);
  assert.equal(state.page.status, 'idle');
});

test('pagination from a previous search cannot change the current search', () => {
  const state = searchReducer(initialSearchState, { type: 'search-success', result: page('current', ['a.ts']) });
  assert.equal(searchReducer(state, { type: 'page-success', searchId: 'old', result: page('old', ['b.ts']) }), state);
  assert.equal(searchReducer(state, { type: 'page-error', searchId: 'old', error: 'Expired' }), state);
  assert.equal(searchReducer(initialSearchState, { type: 'page-start', searchId: 'current' }), initialSearchState);
});


test('pagination rejects duplicate starts, unsolicited results and exhausted searches', () => {
  const ready = searchReducer(initialSearchState, { type: 'search-success', result: page('current', ['a.ts']) });
  const success = { type: 'page-success', searchId: 'current', result: page('current', ['b.ts'], null) };
  assert.equal(searchReducer(ready, success), ready);
  assert.equal(searchReducer(ready, { type: 'page-start', searchId: 'old' }), ready);
  const loading = searchReducer(ready, { type: 'page-start', searchId: 'current' });
  assert.equal(searchReducer(loading, { type: 'page-start', searchId: 'current' }), loading);
  const complete = searchReducer(loading, success);
  assert.equal(searchReducer(complete, success), complete);
  assert.equal(searchReducer(complete, { type: 'page-start', searchId: 'current' }), complete);
});

test('a mismatched response snapshot preserves files and reports an error', () => {
  let state = searchReducer(initialSearchState, { type: 'search-success', result: page('current', ['a.ts']) });
  state = searchReducer(state, { type: 'page-start', searchId: 'current' });
  state = searchReducer(state, { type: 'page-success', searchId: 'current', result: page('other', ['b.ts']) });
  assert.equal(state.result.searchId, 'current');
  assert.deepEqual(state.result.files.map(file => file.path), ['a.ts']);
  assert.equal(state.page.status, 'error');
});
