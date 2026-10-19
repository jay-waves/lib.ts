import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderNavigation, readerView, readerViews, readerRouteRequest } from '../web/reader-session.mjs';

function fixture() {
  const frames = new Map();
  let next = 0;
  const navigation = createReaderNavigation(callback => { frames.set(++next, callback); return next; }, id => frames.delete(id));
  const flush = () => { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); };
  return { navigation, frames, flush };
}

test('new navigation cancels the previous scheduled restore', () => {
  const { navigation, frames, flush } = fixture(), visits = [];
  navigation.request(() => visits.push('old'));
  navigation.request(() => visits.push('new'));
  assert.equal(frames.size, 1);
  assert.equal(navigation.pending, true);
  flush();
  assert.deepEqual(visits, ['new']);
  assert.equal(navigation.pending, false);
});

test('unloaded content retains navigation until a resize or load retries it', () => {
  const { navigation, frames, flush } = fixture();
  let loaded = false, attempts = 0;
  navigation.request(() => { attempts++; return loaded; });
  flush();
  assert.equal(navigation.pending, true);
  assert.equal(frames.size, 0);
  loaded = true;
  navigation.retry(); navigation.retry();
  assert.equal(frames.size, 1);
  flush();
  assert.equal(attempts, 2);
  assert.equal(navigation.pending, false);
});

test('hidden sessions suspend frames and resume the same navigation', () => {
  const { navigation, frames, flush } = fixture();
  let visits = 0;
  navigation.request(() => visits++);
  navigation.suspend(); flush();
  assert.equal(visits, 0);
  assert.equal(navigation.pending, true);
  navigation.retry(); flush();
  assert.equal(visits, 1);
  navigation.request(() => visits++); navigation.clear();
  assert.equal(frames.size, 0);
  assert.equal(navigation.pending, false);
});

test('an action cannot clear newer navigation requested while it is running', () => {
  const { navigation, flush } = fixture(), visits = [];
  navigation.request(() => { visits.push('first'); navigation.request(() => visits.push('second')); });
  flush();
  assert.equal(navigation.pending, true);
  flush();
  assert.deepEqual(visits, ['first', 'second']);
  assert.equal(navigation.pending, false);
});

test('view policy keeps source-only and preview-only formats consistent with routes', () => {
  assert.equal(readerView({ type: 'text' }, 'preview'), 'raw');
  assert.deepEqual(readerViews({ type: 'text' }), ['raw']);
  for (const type of ['image', 'pdf', 'binary']) assert.equal(readerView({ type }, 'raw'), 'preview');
  for (const type of ['image', 'pdf', 'binary']) assert.deepEqual(readerViews({ type }), ['preview']);
  for (const type of ['markdown', 'typst']) {
    assert.deepEqual(readerViews({ type }), ['preview', 'raw']);
    assert.equal(readerView({ type }, 'raw'), 'raw');
    assert.equal(readerView({ type }, null), 'preview');
  }
  assert.deepEqual(readerRouteRequest('note.md', '?line=42'), { path: 'note.md', line: 42, page: null, view: 'raw' });
  assert.deepEqual(readerRouteRequest('note.typ', '?line=42&view=preview'), { path: 'note.typ', line: 42, page: null, view: 'preview' });
});

test('page bookmark URLs preserve page coordinates through history navigation', () => {
  assert.deepEqual(readerRouteRequest('book.pdf', '?page=3&x=0.5&y=0.25'),
    { path: 'book.pdf', line: null, page: { index: 2, x: 0.5, y: 0.25 }, view: null });
  assert.equal(readerRouteRequest('book.pdf', '?page=-1').page, null);
  assert.equal(readerRouteRequest('book.pdf', '?page=2&x=Infinity').page, null);
});
