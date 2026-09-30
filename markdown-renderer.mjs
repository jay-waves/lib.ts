import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { full as markdownItEmoji } from 'markdown-it-emoji';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItTaskLists from 'markdown-it-task-lists';
import markdownItAnchor from 'markdown-it-anchor';
import katex from 'katex';
import { createHash } from 'node:crypto';
import texmath from 'markdown-it-texmath';
import markdownItGithubAlerts from 'markdown-it-github-alerts';
import { sidenotes } from './src/markdown/sidenotes.js';
import { headingSections } from './src/markdown/heading-sections.js';

const renderers = new Map();
const renderedMarkdown = new Map();
const renderCacheLimit = 64;
const renderCacheTtl = 5 * 60 * 1000;

function pruneRenderCache(now = Date.now()) {
  for (const [key, entry] of renderedMarkdown) {
    if (entry.expiresAt <= now) renderedMarkdown.delete(key);
  }
}

const renderCacheCleanup = setInterval(() => pruneRenderCache(), 60 * 1000);
renderCacheCleanup.unref?.();

function createRenderer(allowRawHtml) {
  const md = new MarkdownIt({
    html: allowRawHtml,
    linkify: true,
    typographer: true,
    highlight(source, language) {
      if (language && hljs.getLanguage(language)) {
        try {
          return hljs.highlight(source, { language, ignoreIllegals: true }).value;
        } catch {}
      }
      return '';
    },
  });

  md.block.ruler.before('table', 'front_matter', (state, startLine, endLine, silent) => {
    if (startLine !== 0 || state.blkIndent !== 0
      || state.src.slice(state.bMarks[0], state.eMarks[0]) !== '---') return false;
    let closed = -1;
    for (let next = startLine + 1; next < endLine; next++) {
      if (state.tShift[next] > 0) continue;
      if (/^---\s*$/.test(state.src.slice(state.bMarks[next], state.eMarks[next]))) { closed = next; break; }
    }
    if (closed < 0) return false;
    if (silent) return true;
    const token = state.push('fence', 'code', 0);
    token.info = 'yaml';
    token.content = state.src.slice(state.bMarks[1], state.bMarks[closed]);
    token.map = [startLine, closed + 1];
    state.line = closed + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.use(markdownItGithubAlerts);
  md.use(markdownItEmoji);
  md.use(markdownItFootnote);
  md.use(sidenotes);
  md.use(markdownItTaskLists, { enabled: false });
  md.use(markdownItAnchor, { permalink: false,
    slugify: value => value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '') });
  md.use(texmath, { engine: katex, delimiters: ['dollars', 'beg_end'] });
  md.use(headingSections);

  function injectLineNumbers(tokens, index, options, env, renderer) {
    if (tokens[index].map) {
      tokens[index].attrJoin('class', 'source-line');
      tokens[index].attrSet('data-source-line', String(tokens[index].map[0]));
    }
    return renderer.renderToken(tokens, index, options, env, renderer);
  }
  md.renderer.rules.paragraph_open = injectLineNumbers;
  md.renderer.rules.heading_open = injectLineNumbers;
  md.renderer.rules.list_item_open = injectLineNumbers;
  md.renderer.rules.table_open = injectLineNumbers;
  md.renderer.rules.blockquote_open = injectLineNumbers;

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const lineAttribute = token.map ? ` data-source-line="${token.map[0]}"` : '';
    const html = defaultFence
      ? defaultFence(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
    const language = token.info.trim().split(/\s+/, 1)[0] || '';
    const escapedLanguage = md.utils.escapeHtml(language);
    const positionedHtml = lineAttribute ? html.replace(/^<pre\b/, `<pre${lineAttribute}`) : html;
    return `<div class="code-wrap">${positionedHtml}${language ? `<span class="code-lang">${escapedLanguage}</span>` : ''}</div>`;
  };
  return md;
}

export function renderMarkdown(source, { allowRawHtml = true } = {}) {
  source = String(source);
  const key = allowRawHtml ? 'html' : 'safe';
  const cacheKey = `${key}:${createHash('sha256').update(source).digest('hex')}`;
  const now = Date.now();
  const cached = renderedMarkdown.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    renderedMarkdown.delete(cacheKey);
    renderedMarkdown.set(cacheKey, { html: cached.html, expiresAt: now + renderCacheTtl });
    return cached.html;
  }
  if (cached) renderedMarkdown.delete(cacheKey);
  let renderer = renderers.get(key);
  if (!renderer) { renderer = createRenderer(allowRawHtml); renderers.set(key, renderer); }
  const html = renderer.render(source);
  renderedMarkdown.set(cacheKey, { html, expiresAt: now + renderCacheTtl });
  while (renderedMarkdown.size > renderCacheLimit) {
    renderedMarkdown.delete(renderedMarkdown.keys().next().value);
  }
  return html;
}
