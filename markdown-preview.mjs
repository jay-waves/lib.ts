import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileResponse } from './file-response.mjs';

export function createMarkdownPreview({ dist, json, emit, publish, renderMarkdown }) {
  let document;

  function update(data) {
    const file = resolve(data.file);
    const directory = dirname(file);
    const cwd = resolve(data.cwd || directory);
    const relCwd = relative(cwd, directory);
    const root = relCwd === '..' || relCwd.startsWith('..\\') || relCwd.startsWith('../') || isAbsolute(relCwd)
      ? directory : cwd;
    const relDir = relative(root, directory);
    const previous = document;
    const text = String(data.text ?? previous?.text ?? '');
    const revision = data.revision ?? previous?.revision ?? 0;
    const options = data.options || previous?.options || {};
    const prefix = relDir === '.' ? '' : relDir.split(/[\\/]/).join('/');
    const switched = !previous || pathKey(previous.file) !== pathKey(file);
    const renderChanged = switched || previous.text !== text
      || (previous.options.allow_raw_html !== false) !== (options.allow_raw_html !== false);
    const changed = renderChanged || previous.revision !== revision || previous.root !== root || previous.prefix !== prefix;
    const reload = changed || data.method === 'open';
    document = { file, text, cwd, root, buffer: data.buffer ?? previous?.buffer, revision,
      dirty: false, options, prefix,
      identity: { document: pathKey(file), version: reload ? (previous?.identity.version ?? 0) + 1 : previous.identity.version,
        revision },
      initialScroll: switched ? null : previous?.initialScroll ?? null };
    document.html = renderChanged ? renderMarkdown(text, { allowRawHtml: options.allow_raw_html !== false }) : previous.html;
    if (switched || data.method === 'open') document.initialScroll = {
      id: randomBytes(8).toString('hex'), line: Math.max(0, (data.line || 1) - 1), total: text.split('\n').length,
    };
    if (reload) publish('markdown', 'reload');
  }

  async function page() {
    let html = await readFile(resolve(dist, 'src/markdown/index.html'), 'utf8');
    const options = document?.options || {};
    html = html.replace('<html ', `<html data-bottom-padding="0.5" data-click-to-nvim="${options.click_to_nvim === false ? 'false' : 'true'}" `);
    const styles = [];
    for (const name of options.custom_css || []) {
      try { styles.push(`<style>${await readFile(resolve(name), 'utf8')}</style>`); }
      catch (error) { emit({ event: 'notice', kind: 'markdown', message: `custom_css: ${error.message}` }); }
    }
    return html.replace('</head>', `${styles.join('\n')}\n</head>`);
  }

  async function asset(url) {
    const assetPath = url.searchParams.get('p') || '';
    const version = url.searchParams.get('v');
    if (!document || version !== String(document.identity.version) || !assetPath || assetPath.includes('\0'))
      return json({ error: 'asset not found' }, 404);
    const target = resolve(document.root, assetPath);
    const rel = relative(document.root, target);
    if (rel.startsWith('..') || isAbsolute(rel)) return json({ error: 'asset not found' }, 404);
    try { return await fileResponse(target, { 'cache-control': 'no-store' }) || json({ error: 'asset not found' }, 404); }
    catch { return json({ error: 'asset not found' }, 404); }
  }

  function state() {
    if (!document) return { html: '', assetPrefix: '', title: 'Markdown Preview' };
    return { ...document.identity, html: document.html, assetPrefix: document.prefix,
      title: document.file.split(/[\\/]/).pop() || 'Markdown Preview', initialScroll: document.initialScroll };
  }

  async function control(message) {
    if (message.method === 'cursor' && document && pathKey(message.file || message.document) === pathKey(document.file)) {
      await publish('markdown', 'scroll', { version: document.identity.version,
        line: Math.max(0, message.line - 1), total: document.text.split('\n').length });
    } else if (message.method === 'dirty' && document && pathKey(message.file) === pathKey(document.file)) {
      document.dirty = Boolean(message.modified);
    } else if (['open', 'refresh', 'activate'].includes(message.method) && message.file && typeof message.text === 'string') {
      if (message.method !== 'refresh' || !document || pathKey(message.file) === pathKey(document.file)) update(message);
    }
  }

  function browserEvent(event, data) {
    if (event === 'markdown-click' && document && !document.dirty
      && data.document === document.identity.document && data.version === document.identity.version
      && data.revision === document.identity.revision && Number.isInteger(data.line)
      && data.line >= 0 && data.line < document.text.split('\n').length && document.options.click_to_nvim !== false) {
      emit({ event: 'jump', kind: 'markdown', file: document.file, buffer: document.buffer,
        revision: document.revision, line: data.line + 1 });
    }
  }

  function stop() { document = null; }
  return { update, page, asset, state, control, browserEvent, stop, get document() { return document; } };
}

function pathKey(file) { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file); }
