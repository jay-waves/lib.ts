// Render one hidden note per containing paragraph (or table), shared by its refs.
export function inlineFootnotes(md) {
  const originalRef = md.renderer.rules.footnote_ref;
  md.renderer.rules.footnote_caption = (tokens, index) => `[${tokens[index].meta.id + 1}]`;
  md.renderer.rules.footnote_ref = (tokens, index, options, env, renderer) => {
    const target = tokens[index].meta.target;
    const html = originalRef(tokens, index, options, env, renderer);
    return target ? html.replace(/href="[^"]*"/, `href="#${target}" data-footnote-ref="${target}" aria-controls="${target}" aria-expanded="false"`) : html;
  };
  md.renderer.rules.inline_footnote = (tokens, index, options, env, renderer) => {
    const { id, target, ref, body } = tokens[index].meta;
    const label = `<a href="#${ref}" class="footnote-label" aria-label="Close footnote and return to reference">[${id + 1}]</a>`;
    const rendered = renderer.render(body, options, env);
    const html = /^<p\b/.test(rendered)
      ? rendered.replace(/^<p\b[^>]*>/, `$&${label} `) : `<p>${label}</p>\n${rendered}`;
    return `<aside id="${target}" class="inline-footnote" role="doc-footnote" hidden>\n${html}</aside>\n`;
  };
  md.core.ruler.after('footnote_tail', 'inline_footnotes', state => {
    const start = state.tokens.findIndex(token => token.type === 'footnote_block_open');
    if (start < 0) return;
    const notes = new Map();
    let body;
    for (const token of state.tokens.splice(start)) {
      if (token.type === 'footnote_open') { body = []; notes.set(token.meta.id, body); }
      else if (token.type === 'footnote_close') body = null;
      else if (body && token.type !== 'footnote_anchor') {
        // Expanded notes belong to the reference position, not the definition
        // lines at the end of the source; keep them out of scroll-sync anchors.
        token.map = null;
        body.push(token);
      }
    }
    const output = [], pending = new Map();
    let inTable = false;
    for (const token of state.tokens) {
      output.push(token);
      if (token.type === 'table_open') inTable = true;
      if (token.type === 'table_close') inTable = false;
      for (const child of token.children || []) {
        if (child.type !== 'footnote_ref' || !notes.has(child.meta.id)) continue;
        const { id, subId = 0 } = child.meta;
        if (!pending.has(id)) {
          const note = new state.Token('inline_footnote', '', 0);
          note.block = true;
          note.meta = { id, target: `fn${id + 1}${subId ? `-${subId}` : ''}`,
            ref: `fnref${id + 1}${subId ? `:${subId}` : ''}`, body: notes.get(id) };
          pending.set(id, note);
        }
        child.meta.target = pending.get(id).meta.target;
      }
      if (!inTable && ['paragraph_close', 'heading_close', 'table_close'].includes(token.type)) {
        output.push(...pending.values());
        pending.clear();
      }
    }
    state.tokens = output;
  });
}
