import test from 'node:test';
import assert from 'node:assert/strict';
import { bindViewportGestures, fitDocumentPage } from '../web/document-viewport.mjs';

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

function fixture(options = {}) {
  const captures = new Set(), zooms = [];
  let scale = .8;
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: new EventTarget(), contains: target => target === viewport, matches: () => false,
    scrollLeft: 250, scrollTop: 400, clientWidth: 800, clientHeight: 600,
    classList: { add() {}, remove() {} }, focus() {},
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture: id => captures.delete(id),
    scrollTo: value => { viewport.scrollLeft = value.left; viewport.scrollTop = value.top; },
  });
  viewport.ownerDocument.activeElement = viewport;
  const dispose = bindViewportGestures(viewport, {
    getScale: () => scale,
    zoom: (next, point, previous) => { scale = next; zooms.push({ next, point, previous }); },
    ...options,
  });
  function send(type, props = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: 'mouse', button: 1, clientX: 300, clientY: 200,
      deltaMode: 0, deltaY: -100, ...props });
    if (type === 'keydown') {
      Object.defineProperty(event, 'target', { value: viewport });
      viewport.ownerDocument.dispatchEvent(event);
    } else viewport.dispatchEvent(event);
    return event;
  }
  return { viewport, zooms, captures, send, dispose };
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


test('ordinary scrolling keys and wheel input remain native', () => {
  const f = fixture();
  assert.equal(f.send('wheel', { deltaY: 80 }).defaultPrevented, false);
  assert.equal(f.send('wheel', { deltaX: 100, deltaY: 2 }).defaultPrevented, false);
  assert.equal(f.send('wheel', { shiftKey: true }).defaultPrevented, false);
  for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])
    assert.equal(f.send('keydown', { key }).defaultPrevented, false);
  assert.equal(f.zooms.length, 0);
  f.dispose();
});

test('shared viewport leaves search and Git views out of document gestures', () => {
  let enabled = false;
  const f = fixture({ isEnabled: () => enabled });
  assert.equal(f.send('wheel', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(f.send('keydown', { ctrlKey: true, key: '+' }).defaultPrevented, false);
  assert.equal(f.send('pointerdown').defaultPrevented, false);
  assert.equal(f.captures.size, 0);
  assert.equal(f.zooms.length, 0);
  enabled = true;
  assert.equal(f.send('wheel', { ctrlKey: true }).defaultPrevented, true);
  f.dispose();
});

test('PathBar links and toolbar controls do not start a document pan', () => {
  const f = fixture();
  f.viewport.closest = selector => selector === '.page-header, .file-toolbar' ? {} : null;
  assert.equal(f.send('pointerdown').defaultPrevented, false);
  assert.equal(f.send('pointerdown', { pointerType: 'touch' }).defaultPrevented, false);
  assert.equal(f.captures.size, 0);
  f.dispose();
});


test('panning keeps horizontal movement inside the canvas and vertical movement on the page', () => {
  const horizontal = { scrollLeft: 250, scrollTo(value) { this.scrollLeft = value.left; } };
  const f = fixture({ horizontalViewport: horizontal });
  f.send('pointerdown');
  f.send('pointermove', { clientX: 350, clientY: 240 });
  assert.equal(horizontal.scrollLeft, 200);
  assert.equal(f.viewport.scrollLeft, 0);
  assert.equal(f.viewport.scrollTop, 360);
  f.dispose();
});
