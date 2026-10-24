import katex from 'katex';
import { hljs, rawLanguage } from '../../web/raw/raw-highlight.mjs';
import { render } from 'pele';

// Only string APIs are used: no DOM, Node runtime, network or browser globals.
globalThis.renderFragment = (kind, source, language, index) => {
  try {
    let html;
    if (kind === 'math' || kind === 'display') {
      html = katex.renderToString(source.replace(/\u200b/g, ''), {
        displayMode: kind === 'display', throwOnError: true, trust: false,
      });
    } else if (kind === 'diagram') {
      html = render(source, {
        idPrefix: `diagram-${index}`, autoDirection: false, maxWidth: 900,
        // Diagram image attachments require their own asset traversal; do not
        // silently leave unmanaged images in an otherwise standalone document.
        images: false,
      }).svg;
    } else {
      const resolved = rawLanguage(language);
      html = resolved ? hljs.highlight(source, { language: resolved, ignoreIllegals: true }).value : null;
    }
    return { html };
  } catch (error) {
    return { error: error.message || String(error) };
  }
};
