import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFootnote } from '../web/markdown/footnotes.mjs';

function fixture() {
  let movement, focused;
  const link = (id, attrs = {}) => ({ id, attrs,
    getAttribute(name) { return this.attrs[name] ?? null; },
    setAttribute(name, value) { this.attrs[name] = value; },
    classList: { contains: name => name === 'footnote-label' && id === 'back' },
    closest: () => note,
    focus: options => { focused = { id, options }; },
    getBoundingClientRect: () => ({ top: 100, bottom: 115 }),
  });
  const refs = [link('fnref1', { 'data-footnote-ref': 'fn1' }), link('fnref1:1', { 'data-footnote-ref': 'fn1' })];
  const back = link('back', { href: '#fnref1' });
  const note = { id: 'fn1', hidden: true, querySelector: () => back };
  const panel = { scrollTop: 200, getBoundingClientRect: () => ({ top: 0, bottom: 600 }),
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 50 }) }),
    scrollTo: value => { movement = value; } };
  const root = { querySelectorAll: selector => selector === '.inline-footnote' ? [note] : refs,
    closest: () => panel };
  return { root, refs, back, note, link, movement: () => movement, focused: () => focused };
}

test('either reference toggles their shared note, without affecting links in the content', () => {
  const { root, refs, note, link } = fixture();
  assert.equal(toggleFootnote(root, refs[0]), true);
  assert.equal(note.hidden, false);
  assert.ok(refs.every(ref => ref.attrs['aria-expanded'] === 'true'));
  assert.equal(toggleFootnote(root, link('ordinary', { href: 'https://example.com' })), false);
  assert.equal(note.hidden, false);
  toggleFootnote(root, refs[1]);
  assert.equal(note.hidden, true);
  assert.ok(refs.every(ref => ref.attrs['aria-expanded'] === 'false'));
});

test('note label closes and focuses the reference that opened it, without scrolling a visible ref', () => {
  const f = fixture();
  toggleFootnote(f.root, f.refs[1]);
  assert.equal(f.back.attrs.href, '#fnref1:1');
  toggleFootnote(f.root, f.back);
  assert.equal(f.note.hidden, true);
  assert.deepEqual(f.focused(), { id: 'fnref1:1', options: { preventScroll: true } });
  assert.equal(f.movement(), undefined);
});

test('note label brings an offscreen reference below the toolbar', () => {
  const f = fixture();
  f.refs[0].getBoundingClientRect = () => ({ top: -100, bottom: -85 });
  toggleFootnote(f.root, f.refs[0]);
  toggleFootnote(f.root, f.back);
  assert.deepEqual(f.movement(), { top: 38, behavior: 'instant' });
});
