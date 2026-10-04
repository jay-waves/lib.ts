import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleEvents } from '../library/visible-events.mjs';

function environment(hidden = false) {
  const document = new EventTarget();
  document.hidden = hidden;
  const streams = [];
  class EventSource extends EventTarget {
    constructor(url) { super(); this.url = url; this.closed = false; streams.push(this); }
    close() { this.closed = true; }
  }
  const visibility = hidden => {
    document.hidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return { document, EventSource, streams, visibility };
}

test('switching among many tabs releases background streams and reconnects handlers', () => {
  const tabs = Array.from({ length: 10 }, (_, i) => environment(i !== 0));
  let connections = 0;
  const subscriptions = tabs.map(tab => Array.from({ length: 3 }, (_, i) =>
    visibleEvents(`/events/${i}`, { connected: () => connections++ }, tab)));
  const live = () => tabs.flatMap(tab => tab.streams).filter(stream => !stream.closed);
  for (let i = 0; i < tabs.length; i++) {
    if (i) { tabs[i - 1].visibility(true); tabs[i].visibility(false); }
    tabs[i].visibility(false); // Repeated visibility notifications do not duplicate streams.
    assert.equal(live().length, 3);
    for (const stream of live()) stream.dispatchEvent(new Event('connected'));
  }
  tabs[9].visibility(true);
  tabs[0].visibility(false);
  assert.equal(live().length, 3);
  for (const stream of live()) stream.dispatchEvent(new Event('connected'));
  assert.equal(connections, 33);
  for (const group of subscriptions) for (const subscription of group) subscription.close();
  for (const tab of tabs) tab.visibility(false);
  assert.equal(live().length, 0);
});

test('a hidden initial tab opens no stream, including after disposal', () => {
  const tab = environment(true);
  const subscription = visibleEvents('/events', {}, tab);
  assert.equal(tab.streams.length, 0);
  subscription.close();
  tab.visibility(false);
  assert.equal(tab.streams.length, 0);
});

test('bfcache closes streams and reconnects on restore without a focus event', () => {
  const tab = environment();
  tab.window = new EventTarget();
  tab.window.document = tab.document;
  tab.document.hasFocus = () => true;
  const subscription = visibleEvents('/events', {}, tab);
  tab.window.dispatchEvent(new Event('pagehide'));
  assert.ok(tab.streams[0].closed);
  tab.visibility(false);
  assert.equal(tab.streams.length, 1);
  tab.window.dispatchEvent(new Event('pageshow'));
  assert.equal(tab.streams.length, 2);
  subscription.close();
  tab.window.dispatchEvent(new Event('pageshow'));
  assert.equal(tab.streams.length, 2);
  assert.ok(tab.streams.every(stream => stream.closed));
});
