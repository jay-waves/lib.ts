import test from 'node:test';
import assert from 'node:assert/strict';

let serial = 0;
function storage(initial = {}) {
  const entries = new Map(Object.entries(initial)), writes = [];
  return { writes,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); writes.push([key, value]); } };
}
async function setup(t, local = storage()) {
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  const state = await import(`../web/reading-state.mjs?storage-test=${serial++}`);
  t.after(() => {
    state.flushReadingPositions();
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete globalThis.localStorage;
  });
  return { ...state, local };
}

test('reading positions restore synchronously across reloads without any network requests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Positions must stay local'); });
  const state = await setup(t);
  const key = state.readingKey('/notes', 'file.md');
  state.savePosition(key, { line: 80, view: 'raw', collapsed: ['heading'] });
  assert.deepEqual(state.readPosition(key), { line: 80, view: 'raw', collapsed: ['heading'] });
  state.flushReadingPositions();
  const reloaded = await import(`../web/reading-state.mjs?storage-test=${serial++}`);
  assert.deepEqual(reloaded.readPosition(key), state.readPosition(key));
  assert.deepEqual(reloaded.readPosition(reloaded.readingKey('/other', 'file.md')), {});
  assert.equal(fetch.mock.callCount(), 0);
});

test('frequent captures coalesce and unchanged positions never write again', async t => {
  const state = await setup(t), key = state.readingKey('/notes', 'book.pdf');
  for (let line = 1; line <= 100; line++) state.savePosition(key, { line, scale: 1.5 });
  assert.equal(state.local.writes.length, 0);
  assert.equal(state.readPosition(key).line, 100);
  state.flushReadingPositions();
  assert.equal(state.local.writes.length, 1);
  state.savePosition(key, { line: 100, scale: 1.5 });
  state.flushReadingPositions();
  assert.equal(state.local.writes.length, 1);
  state.savePosition(key, { line: 101 });
  state.flushReadingPositions();
  assert.equal(state.local.writes.length, 2);
});

test('continuous captures still flush every 500 ms rather than postponing the write indefinitely', async t => {
  const state = await setup(t), key = state.readingKey('/notes', 'file.md');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  state.savePosition(key, { line: 1 });
  t.mock.timers.tick(499);
  state.savePosition(key, { line: 2 });
  assert.equal(state.local.writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(state.local.writes.length, 1);
  assert.equal(JSON.parse(state.local.getItem('library-reading-cache')).positions[0][1].line, 2);
});

test('the browser cache retains only 100 recent files across repositories', async t => {
  const state = await setup(t);
  for (let index = 0; index < 150; index++) state.savePosition(state.readingKey(`/repo${index % 2}`, `${index}.md`), { line: index + 1 });
  state.flushReadingPositions();
  const saved = JSON.parse(state.local.getItem('library-reading-cache'));
  assert.equal(saved.positions.length, 100);
  assert.deepEqual(state.readPosition(state.readingKey('/repo0', '0.md')), {});
  assert.equal(saved.positions.at(-1)[1].line, 150);
});

test('unavailable storage keeps working in memory', async t => {
  const local = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const state = await setup(t, local);
  const key = state.readingKey('/notes', 'file.md');
  assert.deepEqual(state.readPosition(key), {});
  state.savePosition(key, { line: 42 });
  assert.doesNotThrow(() => state.flushReadingPositions());
  assert.deepEqual(state.readPosition(key), { line: 42 });
});
