import test from 'node:test';
import assert from 'node:assert/strict';
import { bindZoomInput } from '../web/zoom-input.mjs';
import { bindGalleryZoom, resizeGallery } from '../web/gallery/gallery-zoom.mjs';
import { galleryLayout, galleryRows } from '../web/gallery/gallery-layout.mjs';

function fixture() {
  const document = new EventTarget();
  const toolbar = {}, gutter = {}, sidebar = {};
  const viewport = Object.assign(new EventTarget(), {
    ownerDocument: document, clientHeight: 600,
    contains: target => [viewport, toolbar, gutter].includes(target),
    matches: () => false,
  });
  document.activeElement = viewport;
  const send = (recipient, type, properties = {}, target) => {
    const event = new Event(type, { cancelable: true });
    if (target) Object.defineProperty(event, 'target', { value: target });
    Object.assign(event, properties);
    recipient.dispatchEvent(event);
    return event;
  };
  const hover = target => send(document, 'pointerover', {}, target);
  const key = (key, target = document) => send(document, 'keydown', { ctrlKey: true, key }, target);
  const wheel = deltaY => send(viewport, 'wheel', { ctrlKey: true, deltaY, deltaMode: 0 });
  return { document, viewport, toolbar, gutter, sidebar, send, hover, key, wheel };
}
const wait = () => new Promise(resolve => setTimeout(resolve, 15));

test('keyboard zoom follows focus inside the reader, regardless of mouse position', () => {
  const f = fixture(), changes = [];
  const dispose = bindZoomInput(f.viewport, { key: (...args) => changes.push(args), wheel() {} });
  f.document.activeElement = f.viewport;
  f.hover(f.sidebar);
  assert.equal(f.key('+').defaultPrevented, true);
  f.document.activeElement = f.toolbar;
  assert.equal(f.key('-').defaultPrevented, true);
  f.document.activeElement = f.sidebar;
  f.hover(f.viewport);
  assert.equal(f.key('+').defaultPrevented, false);
  assert.equal(changes.length, 2);
  dispose();
  f.document.activeElement = f.viewport;
  assert.equal(f.key('+').defaultPrevented, false);
});

test('gallery rejects noise and coalesces a large wheel burst to one step', async () => {
  const f = fixture(), changes = [];
  const dispose = bindGalleryZoom(f.viewport, (...args) => changes.push(args), { delay: 5 });
  assert.equal(f.wheel(-10).defaultPrevented, true);
  await wait();
  assert.deepEqual(changes, []);
  f.wheel(-30); f.wheel(-40); f.wheel(-1000);
  assert.deepEqual(changes, []);
  await wait();
  assert.deepEqual(changes, [[1, false, 'wheel']]);
  f.wheel(100);
  await wait();
  assert.deepEqual(changes.at(-1), [-1, false, 'wheel']);
  dispose();
});

test('a continuous wheel gesture updates once after it ends', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), changes = [];
  const dispose = bindGalleryZoom(f.viewport, (...args) => changes.push(args));
  for (let i = 0; i < 12; i++) { f.wheel(-30); t.mock.timers.tick(25); }
  assert.equal(changes.length, 0);
  t.mock.timers.tick(100);
  assert.deepEqual(changes, [[1, false, 'wheel']]);
  dispose();
});

test('every keyboard press applies immediately and cancels queued wheel input', async () => {
  const f = fixture(), changes = [];
  const dispose = bindGalleryZoom(f.viewport, (...args) => changes.push(args), { delay: 5 });
  f.hover(f.toolbar);
  f.wheel(-100);
  f.key('+'); f.key('+'); f.key('+'); f.key('-'); f.key('0');
  assert.deepEqual(changes, [[1, false, 'key'], [1, false, 'key'], [1, false, 'key'], [-1, false, 'key'], [0, true, 'key']]);
  await wait();
  assert.equal(changes.length, 5);
  assert.equal(resizeGallery(420, 1, false), 420);
  assert.equal(resizeGallery(140, -1, false), 140);
  assert.equal(resizeGallery(220, 1, false), 240);
  assert.equal(resizeGallery(220, -1, false), 200);
  assert.equal(resizeGallery(225, 1, false), 240);
  assert.equal(resizeGallery(420, 0, true), 220);
  dispose();
});

test('column zoom skips unchanged layouts in both directions and stops at its limits', () => {
  for (const width of [240, 452, 800, 1200]) {
    for (let size = 140; size <= 420; size += 20) {
      for (const direction of [-1, 1]) {
        const next = resizeGallery(size, direction, false, width, false);
        assert.ok(next >= 140 && next <= 420);
        if (next !== size) {
          assert.equal(Math.sign(next - size), direction);
          assert.notDeepEqual(galleryLayout([1, .5], width, next).items,
            galleryLayout([1, .5], width, size).items);
        }
      }
    }
  }
});

test('adjusted height zoom skips identical row partitions and disables unavailable steps', () => {
  const ratios = Array(12).fill(1);
  assert.equal(resizeGallery(220, 1, false, 1000, true, ratios), 300);
  assert.equal(resizeGallery(220, -1, false, 1000, true, ratios), 180);
  assert.equal(resizeGallery(220, 1, false, 1000, true, [1]), 220);
  assert.equal(resizeGallery(220, -1, false, 1000, true, [1]), 220);
  for (const ratios of [Array(12).fill(1), [.5, 3, 1, .8, 2, 1.5, .4]]) {
    const photos = ratios.map(ratio => ({ src: '', width: ratio * 1000, height: 1000 }));
    for (const width of [240, 800, 1000]) {
      const key = size => galleryRows(photos, width, size).tracks.map(track => track.photos.length).join(',');
      for (let size = 140; size <= 420; size += 20) {
        for (const direction of [-1, 1]) {
          const next = resizeGallery(size, direction, false, width, true, ratios);
          if (next !== size) {
            assert.equal(Math.sign(next - size), direction);
            assert.notEqual(key(next), key(size));
          }
        }
      }
    }
  }
});

test('direction reversal, hiding and disposal discard pending wheel changes', async () => {
  const f = fixture(), changes = [];
  let enabled = true;
  const dispose = bindGalleryZoom(f.viewport, (...args) => changes.push(args), { delay: 5, isEnabled: () => enabled });
  f.wheel(-50); f.wheel(20);
  await wait();
  assert.equal(changes.length, 0);
  f.wheel(-100);
  enabled = false;
  await wait();
  assert.equal(changes.length, 0);
  assert.equal(f.wheel(-100).defaultPrevented, false);
  enabled = true;
  f.wheel(-100);
  dispose();
  await wait();
  assert.equal(changes.length, 0);
  assert.equal(f.wheel(-100).defaultPrevented, false);
});
