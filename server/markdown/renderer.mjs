import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItTaskLists from 'markdown-it-task-lists';
import markdownItAnchor from 'markdown-it-anchor';
import katex from 'katex';
import texmath from 'markdown-it-texmath';
import { inlineFootnotes } from './footnotes.js';
import { headingSections } from './heading-sections.js';

const renderers = new Map();

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

  md.use(markdownItFootnote);
  md.use(inlineFootnotes);
  md.use(markdownItTaskLists, { enabled: false });
  md.use(markdownItAnchor, { permalink: false,
    // Keep non-Latin headings addressable, and never emit an empty anchor:
    // the outline requires an ID even for symbol-only or formula-only headings.
    slugify: value => value.trim().toLowerCase().replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{M}\p{N}_-]/gu, '') || 'heading' });
  md.use(texmath, { engine: {
    // Pasted zero-width spaces are invisible but unsupported by KaTeX.
    // Normalize only formula input; preserve prose, code and source positions.
    renderToString: (source, options) => katex.renderToString(source.replace(/\u200b/g, ''), options),
  }, delimiters: ['dollars', 'beg_end'] });
  md.use(headingSections);

  function injectLineNumber(tokens, index, options, env, renderer) {
    const token = tokens[index];
    if (token.map) token.attrSet('data-source-line', String(token.map[0]));
    return renderer.renderToken(tokens, index, options, env, renderer);
  }
  for (const rule of ['paragraph_open', 'heading_open', 'list_item_open', 'table_open', 'blockquote_open']) {
    md.renderer.rules[rule] = injectLineNumber;
  }

  const defaultCodeBlock = md.renderer.rules.code_block;
  md.renderer.rules.code_block = (tokens, index, options, env, renderer) => {
    const html = defaultCodeBlock(tokens, index, options, env, renderer);
    return tokens[index].map
      ? html.replace(/^<pre\b/, `<pre data-source-line="${tokens[index].map[0]}"`) : html;
  };

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
  let renderer = renderers.get(key);
  if (!renderer) { renderer = createRenderer(allowRawHtml); renderers.set(key, renderer); }
  return renderer.render(source);
}
