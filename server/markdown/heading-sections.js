// Wrap top-level Markdown headings and their following blocks into collapsible
// sections. Raw HTML headings remain ordinary content.
export function headingSections(md) {
  md.core.ruler.push('heading_sections', state => {
    const output = [];
    const stack = [];
    const sections = [];
    const occurrences = new Map();
    const make = (type, tag, nesting, attributes = {}) => {
      const token = new state.Token(type, tag, nesting);
      token.block = true;
      for (const [name, value] of Object.entries(attributes)) token.attrSet(name, String(value));
      return token;
    };
    const closeContent = () => {
      if (stack.at(-1)?.contentOpen) {
        output.push(make('heading_content_close', 'div', -1));
        stack.at(-1).contentOpen = false;
      }
    };

    for (let index = 0; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type === 'heading_open' && token.level === 0) {
        closeContent();
        const level = Number(token.tag.slice(1));
        while (stack.length && stack.at(-1).level >= level) {
          output.push(make('heading_section_close', 'section', -1));
          stack.pop();
        }
        if (stack.length) stack.at(-1).hasContent = true;
        const inline = state.tokens[index + 1];
        const identity = token.attrGet('id') || inline?.content?.trim()
          || String(token.map?.[0] ?? index);
        const base = `${token.tag.toUpperCase()}:${identity}`;
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        const section = make('heading_section_open', 'section', 1, {
          class: 'heading-section', 'data-heading-level': level,
          'data-heading-key': `${base}:${occurrence}`,
          id: `heading-section-${encodeURIComponent(`${base}:${occurrence}`)}`,
        });
        const entry = { level, section, contentOpen: false, hasContent: false };
        stack.push(entry);
        sections.push(entry);
        output.push(section, make('heading_summary_open', 'div', 1, {
          class: 'heading-summary', role: 'button', tabindex: 0, 'aria-expanded': true,
        }), token);
      } else if (token.type === 'heading_close' && token.level === 0 && stack.length) {
        output.push(token, make('heading_indicator_open', 'span', 1, {
          class: 'heading-collapsed-indicator', 'aria-hidden': true,
        }));
        const dots = new state.Token('text', '', 0);
        dots.content = '…';
        output.push(dots, make('heading_indicator_close', 'span', -1),
          make('heading_summary_close', 'div', -1),
          make('heading_content_open', 'div', 1, { class: 'heading-content' }));
        stack.at(-1).contentOpen = true;
      } else {
        output.push(token);
        if (stack.at(-1)?.contentOpen && token.level === 0 && token.nesting !== -1
          && token.type !== 'inline') stack.at(-1).hasContent = true;
      }
    }
    closeContent();
    while (stack.length) {
      output.push(make('heading_section_close', 'section', -1));
      stack.pop();
    }
    for (const entry of sections) {
      if (entry.hasContent) entry.section.attrJoin('class', 'has-heading-content');
    }
    state.tokens = output;
  });
}
