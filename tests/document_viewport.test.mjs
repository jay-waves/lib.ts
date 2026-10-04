import test from 'node:test';
import assert from 'node:assert/strict';
import { bindViewportGestures, fitDocumentPage } from '../library/document-viewport.mjs';

test('automatic fitting uses page dimensions and available viewport space', () => {
  const portrait = fitDocumentPage(900, 1200, 948, 648);
  assert.equal(portrait.mode, 'width');
  assert.equal(portrait.scale, 1);
  const tallWindow = fitDocumentPage(900, 1200, 948, 1128);
  assert.equal(tallWindow.mode, 'page');
  assert.equal(tallWindow.scale, .9);
  const landscape = fitDocumentPage(900, 450, 948, 648);
  assert.equal(landscape.mode, 'page');
  assert.equal(landscape.scale, 1);
});

function fixture() {
  const captures = new Set(), zooms = [], navigation = [];
  let scale = .8;
  const viewport = Object.assign(new EventTarget(), {
    scrollLeft: 250, scrollTop: 400, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {} }, focus() {},
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    scrollTo: value => { viewport.scrollLeft = value.left; viewport.scrollTop = value.top; },
  });
  const dispose = bindViewportGestures(viewport, {
    getScale: () => scale, onNavigate: delta => navigation.push(delta),
    zoom: (next, point, previous) => { scale = next; zooms.push({ next, point, previous }); },
  });
  function send(type, props = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 1, clientX: 300, clientY: 200,
      deltaMode: 0, deltaY: -100, ...props });
    viewport.dispatchEvent(event); return event;
  }
  return { viewport, zooms, captures, navigation, send, dispose };
}

test('pan works below 100% and moves both axes; canceled gestures stop moving', () => {
  const f = fixture();
  f.send('pointerdown');
  f.send('pointermove', { clientX: 350, clientY: 240 });
  assert.equal(f.viewport.scrollLeft, 200);
  assert.equal(f.viewport.scrollTop, 360);
  assert.equal(f.send('click').defaultPrevented, true);
  f.send('pointercancel');
  f.send('pointermove', { clientX: 400 });
  assert.equal(f.viewport.scrollLeft, 200);
  assert.equal(f.captures.size, 0);
  f.dispose();
});

test('left button preserves selection and middle button pans', () => {
  const f = fixture();
  assert.equal(f.send('pointerdown', { button: 0 }).defaultPrevented, false);
  assert.equal(f.captures.size, 0);
  f.send('pointerdown', { button: 1 });
  f.send('pointermove', { clientX: 350 });
  assert.equal(f.viewport.scrollLeft, 200);
  f.dispose();
});

test('wheel zoom is scoped, mouse anchored, cumulative and bounded', () => {
  const f = fixture();
  assert.equal(f.send('wheel').defaultPrevented, false);
  assert.equal(f.send('wheel', { ctrlKey: true }).defaultPrevented, true);
  f.send('wheel', { ctrlKey: true });
  assert.deepEqual(f.zooms[0].point, { x: 300, y: 200 });
  assert.ok(f.zooms[1].next > f.zooms[0].next);
  f.send('wheel', { ctrlKey: true, deltaY: -10000 });
  assert.equal(f.zooms.at(-1).next, 4);
  f.dispose();
  f.send('wheel', { ctrlKey: true });
  assert.equal(f.zooms.length, 3);
});

test('touch pinch zooms about its midpoint and resumes single finger panning', () => {
  const f = fixture();
  f.send('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 100 });
  f.send('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 100 });
  f.send('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 100 });
  assert.equal(f.zooms[0].next, 1.6);
  assert.deepEqual(f.zooms[0].previous, { x: 150, y: 100 });
  assert.deepEqual(f.zooms[0].point, { x: 200, y: 100 });
  f.send('pointerup', { pointerId: 2 });
  f.send('pointermove', { clientX: 120, clientY: 130 });
  assert.equal(f.viewport.scrollLeft, 230);
  assert.equal(f.viewport.scrollTop, 370);
  f.dispose();
});

test('scrollbar gestures remain native', () => {
  const f = fixture();
  assert.equal(f.send('pointerdown', { clientX: 825 }).defaultPrevented, false);
  assert.equal(f.captures.size, 0);
  assert.equal(f.send('pointerdown', { button: 0, clientX: 825 }).defaultPrevented, false);
  assert.deepEqual(f.navigation, [0]);
  f.dispose();
});

test('focused keyboard zoom uses the viewport center and reset restores 100%', () => {
  const f = fixture();
  assert.equal(f.send('keydown', { ctrlKey: true, key: '+' }).defaultPrevented, true);
  assert.deepEqual(f.zooms[0].point, { x: 420, y: 330 });
  f.send('keydown', { metaKey: true, key: '0' });
  assert.equal(f.zooms.at(-1).next, 1);
  f.dispose();
});


test('header navigation follows scrolling intent and ignores zoom and horizontal movement', () => {
  const f = fixture();
  f.send('wheel', { deltaY: 80 });
  f.send('wheel', { ctrlKey: true });
  f.send('wheel', { deltaX: 100, deltaY: 2 });
  f.send('wheel', { shiftKey: true });
  f.send('pointerdown');
  f.send('pointermove', { clientY: 240 });
  f.send('keydown', { key: 'ArrowDown' });
  assert.deepEqual(f.navigation, [80, -40, 40]);
  f.dispose();
});
