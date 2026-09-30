// Minimal layout model for state/scroll regressions; no browser dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('preview keeps reading position and ignores stale state/events', async () => {
  let pageWidth = 900;
  let context;
  const requests = [];
  const assetRequests = [];
  let delayAssets = false;
  const events = [];
  const listeners = new Map();
  const listenerOptions = new Map();
  const on = (target, name, fn, options) => {
    listeners.set(`${target}:${name}`, fn);
    listenerOptions.set(`${target}:${name}`, options);
  };
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.dataset = {}; this.attrs = {};
      this.style = { setProperty: (key, value) => { if (key === '--page-width') pageWidth = parseFloat(value); } };
      this.classList = { add() {}, remove() {} }; this.htmlWrites = 0;
    }
    append(el) { el.parent = this; this.children.push(el); }
    replaceChildren(...els) { this.children.forEach(el => { el.parent = null; }); this.children = []; els.forEach(el => this.append(el)); }
    set textContent(value) { this.text = value; this.replaceChildren(); }
    get firstElementChild() { return this.children[0]; }
    set innerHTML(value) { this.html = value; this.htmlWrites++; }
    get innerHTML() { return this.html || ''; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    hasAttribute(name) { return name in this.attrs; }
    removeAttribute(name) { delete this.attrs[name]; }
    get isConnected() { return !!this.parent; }
    addEventListener(name, fn) { on(this.tag, name, fn); }
    closest(selector) { return selector === '.page' && this.className === 'page' ? this : null; }
    querySelector() { return this.firstElementChild; }
    querySelectorAll() { return nav.children.filter(el => el.tag === 'button'); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() {}
    get offsetHeight() { const [w, h] = this.style.aspectRatio.split('/').map(Number); return pageWidth * h / w; }
    get offsetTop() {
      let top = 20;
      for (const el of pages.children) { if (el === this) break; top += el.offsetHeight + 20; }
      return top;
    }
    getBoundingClientRect() {
      const top = this.offsetTop - context.scrollY;
      return { top, bottom: top + this.offsetHeight, left: Math.max(20, (context.innerWidth - pageWidth) / 2) - context.scrollX,
        width: pageWidth, height: this.offsetHeight };
    }
  }
  const pages = new Element('pages');
  const outline = new Element('outline');
  const nav = new Element('nav'); outline.append(nav);
  const body = new Element('body'); body.append(pages); body.append(outline);
  let stream, observer;
  const scrollTo = ({ top = context.scrollY, left = context.scrollX }) => {
    const height = pages.children.reduce((n, el) => n + el.offsetHeight + 20, 20);
    context.scrollY = Math.max(0, Math.min(top, height - context.innerHeight));
    context.scrollX = Math.max(0, left);
  };
  context = vm.createContext({ URL, encodeURIComponent, console, setTimeout, clearTimeout,
    location: { href: 'http://localhost/typst/?t=test' }, innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 0,
    document: { body, title: '', hidden: false, getElementById: id => id === 'pages' ? pages : outline,
      createElement: tag => new Element(tag), addEventListener: (name, fn, options) => on('document', name, fn, options) },
    window: { addEventListener: (name, fn) => on('window', name, fn), close() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    scrollTo, scrollBy: ({ top = 0, left = 0 }) => scrollTo({ top: context.scrollY + top, left: context.scrollX + left }),
    fetch: url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/typst/state') return new Promise(resolve => requests.push(resolve));
      if (parsed.pathname === '/typst/__live/asset') {
        if (delayAssets) return new Promise(resolve => assetRequests.push(resolve));
        return Promise.resolve({ ok: true, text: async () => '<svg></svg>' });
      }
      events.push(JSON.parse(new URL(url, 'http://localhost').searchParams.get('data')));
      return Promise.resolve({ ok: true });
    },
    EventSource: class { constructor() { stream = this; this.handlers = {}; } addEventListener(name, fn) { this.handlers[name] = fn; } close() {} },
    IntersectionObserver: class { constructor(callback) { this.callback = callback; observer = this; } observe() {} disconnect() {} takeRecords() { return []; } },
  });
  vm.runInContext(fs.readFileSync('src/shared/preview-client.js', 'utf8').replace('export function', 'function'), context);
  vm.runInContext(fs.readFileSync('src/typst/preview.js', 'utf8').replace(/^import .*\n/, ''), context);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const snapshot = (document, version, count = 3) => ({ document, version, count,
    title: document, cursor_line: 1, outline: [], files: Array.from({ length: count }, (_, i) => `${version}/${i}.svg`),
    sizes: Array.from({ length: count }, () => ({ width: 210, height: 297 })) });
  const reply = async value => { assert(requests.length, 'expected a state request'); requests.shift()({ ok: true, json: async () => value }); await flush(); };
  const visible = () => observer.callback(pages.children.map(target => ({ target, isIntersecting: true })));
  const key = () => listeners.get('document:keydown')({ key: '0', target: body, preventDefault() {} });

  stream.onopen();
  await reply(snapshot('a', 1)); visible(); await flush();
  key();
  assert(Math.abs(pages.children[0].offsetHeight - 760) < 0.01, 'fit-page height');
  scrollTo({ top: pages.children[2].offsetTop - 20 });
  const before = context.scrollY;
  const content = pages.children[0].firstElementChild;
  const writes = content.htmlWrites;
  stream.handlers.refresh({ data: '{}' });
  await reply(snapshot('a', 2)); visible();
  assert(Math.abs(context.scrollY - before) < 0.01, 'rebuild jumped to originally fitted page');
  assert.equal(content.htmlWrites, writes, 'unchanged inline SVG was reloaded');

  // Two refreshes during one request: never render the superseded response.
  stream.handlers.refresh({ data: '{}' }); stream.handlers.refresh({ data: '{}' });
  await reply(snapshot('stale', 1));
  assert.equal(context.document.title, 'a');
  await reply(snapshot('b', 3));
  assert.equal(context.scrollY, 0);
  assert.equal(pageWidth, 900, 'new document inherited fit/zoom');
  assert(events.some(event => event.document === 'b' && event.theme === 'light'), 'theme not reported for new document');

  // Restoring a cached document must survive its initial waiting-for-SVG state.
  stream.handlers.refresh({ data: '{}' }); await reply(snapshot('a', 4, 0));
  stream.handlers.refresh({ data: '{}' }); await reply(snapshot('a', 5));
  assert(Math.abs(context.scrollY - before) < 0.01, 'waiting state lost saved reading position');
  const restored = context.scrollY;
  stream.handlers.cursor({ data: JSON.stringify({ document: 'b', version: 3, line: 1, page: 1, y: 0 }) });
  assert.equal(context.scrollY, restored, 'stale cursor moved another document');

  stream.handlers.refresh({ data: '{}' });
  stream.handlers.cursor({ data: JSON.stringify({ document: 'a', version: 6, line: 1, page: 1, y: 0 }) });
  await reply(snapshot('a', 6));
  assert.equal(context.scrollY, 0, 'cursor received during state request was lost');

  const wheel = listeners.get('document:wheel');
  assert(wheel, 'pinch must also be handled outside the pages container');
  assert.equal(listenerOptions.get('document:wheel').passive, false);
  assert.equal(listenerOptions.get('document:wheel').capture, true);
  wheel({ ctrlKey: true, deltaY: 100, deltaMode: 0, clientX: 500, clientY: 400, preventDefault() {} });
  assert(pageWidth < 300, 'pinch could not shrink below initial page size');

  // A short document leaves viewport background outside #pages. Repeated
  // pinches there must keep shrinking the document and suppress native zoom.
  stream.handlers.refresh({ data: '{}' }); await reply(snapshot('short', 7, 1));
  let prevented = 0;
  const pinch = { target: body, ctrlKey: true, deltaY: -Math.log(0.9) / 0.01,
    deltaMode: 0, clientX: 500, clientY: 790, preventDefault() { prevented++; } };
  for (let step = 0; step < 12; step++) {
    const previous = pageWidth;
    wheel(pinch);
    assert(Math.abs(pageWidth - previous * 0.9) < 0.01, 'background pinch stopped shrinking');
  }
  assert(pages.children[0].getBoundingClientRect().bottom < pinch.clientY);
  assert.equal(prevented, 12, 'native viewport zoom was not prevented');
  const zoomed = pageWidth;
  wheel({ ...pinch, ctrlKey: false });
  assert.equal(pageWidth, zoomed, 'ordinary scrolling changed zoom');
  assert.equal(prevented, 12, 'ordinary scrolling was prevented');
  outline.showModal();
  wheel(pinch);
  assert.equal(pageWidth, zoomed, 'outline pinch changed document zoom');
  outline.close();
  assert.equal(requests.length, 0, 'unnecessary background polling');

  stream.handlers.refresh({ data: '{}' });
  await reply({ ...snapshot('broken', 8, 0), diagnostics: [{ severity: 'error', message: 'missing font' }] });
  assert.match(pages.text, /Typst preview failed: missing font/);

  delayAssets = true;
  stream.handlers.refresh({ data: '{}' });
  await reply(snapshot('loading', 9, 1));
  visible(); visible();
  assert.equal(assetRequests.length, 1, 'same page was fetched twice while loading');
  assetRequests.shift()({ ok: true, text: async () => '<svg id="loaded" />' });
  await flush();
  assert.match(pages.children[0].firstElementChild.innerHTML, /loaded/);

  stream.handlers['typst-watch-close']();
  assert(body.children.some(el => el.className === 'preview-ended'), 'closed preview needs a visible fallback');
});
