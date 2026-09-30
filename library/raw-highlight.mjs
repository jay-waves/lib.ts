import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('bibtex', hljs => ({
  name: 'BibTeX',
  aliases: ['bib'],
  contains: [
    hljs.COMMENT(/@comment\s*[{(]/i, /[})]/),
    {
      begin: /@[a-z]+\s*[{(]/i,
      beginScope: 'keyword',
      end: /[})]/,
      contains: [
        { className: 'title', begin: /[\w:./-]+(?=\s*,)/ },
        { className: 'attr', begin: /\b[a-z][\w-]*(?=\s*=)/i },
        { className: 'string', begin: /\{/, end: /\}/, contains: ['self'] },
        hljs.QUOTE_STRING_MODE,
        { className: 'number', begin: /\b\d+\b/ },
      ],
    },
  ],
}));

const languages = { typ: 'typst', md: 'markdown', bib: 'bibtex', pwsh: 'powershell' };

export function rawLanguage(name) {
  const extension = name.split('.').pop()?.toLowerCase();
  const language = languages[extension] || extension;
  return language && hljs.getLanguage(language) ? language : null;
}

export function highlightRaw(source, name) {
  const language = rawLanguage(name);
  return language ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(source).value;
}

export { hljs };
