import test from 'node:test';
import assert from 'node:assert/strict';
import { enableSmoothWheel } from '../library/smooth-scroll.mjs';

function fixture() {
  let time = 0, id = 0;
  const frames = new Map();
  let resizeCallback, disconnected = false, dimensionReads = 0;
  let scrollHeight = 2000, clientHeight = 500;
  const media = Object.assign(new EventTarget(), { matches: false });
  const doc = new EventTarget();
  doc.defaultView = {
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    matchMedia: () => media, getComputedStyle: node => ({ overflowY: node.overflowY }),
    performance: { now: () => time },
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: key => frames.delete(key),
  };
  const panel = Object.assign(new EventTarget(), {
    ownerDocument: doc, children: [], scrollTop: 100,
    scrollTo: ({ top }) => { panel.scrollTop = top; },
  });
  Object.defineProperties(panel, {
    scrollHeight: { get: () => { dimensionReads++; return scrollHeight; }, set: value => { scrollHeight = value; } },
    clientHeight: { get: () => { dimensionReads++; return clientHeight; }, set: value => { clientHeight = value; } },
  });
  const dispose = enableSmoothWheel(panel);
  function wheel(props = {}) {
    const event = new Event('wheel', { cancelable: true });
    Object.assign(event, { deltaMode: 0, deltaY: 120, deltaX: 0, ...props });
    panel.dispatchEvent(event);
    return event;
  }
  function step(ms = 16) {
    time += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(time));
  }
  function settle() { for (let i = 0; frames.size && i < 200; i++) step(); assert.equal(frames.size, 0); }
  return { panel, doc, wheel, media, dispose, step, settle, frames,
    resize: () => resizeCallback(), dimensionReads: () => dimensionReads, disconnected: () => disconnected };
}

test('light steps stay small and continuous events preserve speed with one animation', () => {
  const f = fixture();
  assert.equal(f.wheel().defaultPrevented, true);
  f.step();
  assert.ok(f.panel.scrollTop > 100 && f.panel.scrollTop < 110);
  const before = f.panel.scrollTop;
  f.step();
  const previousStep = f.panel.scrollTop - before;
  const nextStart = f.panel.scrollTop;
  f.wheel();
  assert.equal(f.frames.size, 1);
  f.step();
  assert.ok(f.panel.scrollTop - nextStart >= previousStep);
  f.settle();
  assert.equal(f.panel.scrollTop, 196);
  f.dispose();
});

test('one large input and equivalent grouped notches have the same speed curve', () => {
  const a = fixture(), b = fixture();
  a.wheel({ deltaY: 360 });
  for (let i = 0; i < 3; i++) b.wheel();
  for (let i = 0; i < 10; i++) {
    a.step(); b.step();
    assert.ok(Math.abs(a.panel.scrollTop - b.panel.scrollTop) < 1e-8);
  }
  a.settle(); b.settle();
  assert.equal(a.panel.scrollTop, 244);
  a.dispose(); b.dispose();
});

test('time-based smoothing is consistent at different frame rates', () => {
  const a = fixture(), b = fixture();
  a.wheel(); b.wheel();
  for (let i = 0; i < 10; i++) a.step(16);
  for (let i = 0; i < 20; i++) b.step(8);
  assert.ok(Math.abs(a.panel.scrollTop - b.panel.scrollTop) < 1e-8);
  a.dispose(); b.dispose();
});

test('reversal, bounds, external navigation and cleanup take priority', () => {
  const f = fixture();
  f.wheel(); f.step();
  const before = f.panel.scrollTop;
  f.wheel({ deltaY: -120 }); f.step();
  assert.ok(f.panel.scrollTop < before);
  f.settle();
  f.wheel({ deltaY: -10000 }); f.settle();
  assert.equal(f.panel.scrollTop, 0);
  f.wheel({ deltaMode: 2, deltaY: 100 }); f.settle();
  assert.equal(f.panel.scrollTop, 1500);
  f.wheel({ deltaY: -120 });
  f.panel.scrollTop = 700;
  f.step();
  assert.equal(f.panel.scrollTop, 700);
  assert.equal(f.frames.size, 0);
  f.wheel(); f.doc.dispatchEvent(new Event('pointerdown'));
  assert.equal(f.frames.size, 0);
  f.wheel(); f.dispose();
  assert.equal(f.frames.size, 0);
  assert.equal(f.wheel().defaultPrevented, false);
});

test('touchpad, zoom, horizontal gestures and reduced motion use native input', () => {
  const f = fixture();
  for (const props of [{ deltaY: 4 }, { ctrlKey: true }, { metaKey: true },
    { shiftKey: true }, { deltaX: 200 }]) assert.equal(f.wheel(props).defaultPrevented, false);
  f.media.matches = true;
  assert.equal(f.wheel().defaultPrevented, false);
  assert.equal(f.frames.size, 0);
  f.dispose();
});


test('animation reuses bounds until resize and releases its observer on cleanup', () => {
  const f = fixture();
  f.wheel();
  assert.equal(f.dimensionReads(), 2);
  for (let i = 0; i < 5; i++) f.step();
  f.wheel();
  assert.equal(f.dimensionReads(), 2, 'frames and continued wheel input must reuse dimensions');
  f.panel.scrollHeight = 800;
  f.resize();
  f.step();
  assert.equal(f.dimensionReads(), 4);
  f.wheel({ deltaY: 10000 });
  f.settle();
  assert.equal(f.panel.scrollTop, 300, 'changed content bounds must clamp the target');
  f.dispose();
  assert.equal(f.disconnected(), true);
});

test('small touchpad deltas bypass nested element dimensions and computed styles', () => {
  const f = fixture();
  const nested = { nodeType: 1, tagName: 'DIV', parentElement: f.panel,
    get scrollHeight() { assert.fail('native touchpad input must not measure ancestors'); } };
  const event = new Event('wheel', { cancelable: true });
  Object.assign(event, { deltaMode: 0, deltaY: 4, deltaX: 0 });
  Object.defineProperty(event, 'target', { value: nested });
  f.panel.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(f.dimensionReads(), 0);
  f.dispose();
});
