import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import excel from 'highlight.js/lib/languages/excel';

hljs.registerLanguage('powershell', powershell);
// Excel formula syntax only; binary workbooks are handled as file assets.
hljs.registerLanguage('excel', excel);
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
hljs.registerLanguage('typst', hljs => ({
  name: 'Typst',
  aliases: ['typ'],
  contains: [
    hljs.COMMENT('//', '$'),
    { className: 'comment', begin: /\/\*/, end: /\*\//, contains: ['self'] },
    hljs.QUOTE_STRING_MODE,
    { className: 'string', begin: /`/, end: /`/ },
    { className: 'section', begin: /^={1,6}(?=\s)/, end: /$/ },
    { className: 'keyword', begin: /#(?:let|set|show|if|else|for|while|break|continue|return|import|include|as|in|and|or|not)\b/ },
    { className: 'keyword', begin: /\b(?:let|set|show|if|else|for|while|break|continue|return|import|include|as|in|and|or|not)\b/ },
    { className: 'literal', begin: /\b(?:true|false|none|auto)\b/ },
    { className: 'number', begin: /\b\d+(?:\.\d+)?(?:pt|mm|cm|in|em|fr|deg|rad|%)?\b/ },
    { className: 'symbol', begin: /@[\w-]+/ },
    { className: 'tag', begin: /<[\w:-]+>/ },
    { className: 'title.function_', begin: /[\w-]+(?=\s*\()/ },
    { className: 'meta', begin: /^\s*[-+\/](?=\s)/ },
  ],
}));


export function rawLanguage(name) {
  const extension = name.split('.').pop()?.toLowerCase();
  const language = languages[extension] || extension;
  return language && hljs.getLanguage(language) ? language : null;
}

export function highlightElement(element) {
  const className = [...element.classList].find(name => name.startsWith('language-'));
  const language = className ? className.slice('language-'.length) : '';
  if (!language || !hljs.getLanguage(languages[language] || language)) return false;
  hljs.highlightElement(element);
  return true;
}

export function highlightRaw(source, name) {
  const language = rawLanguage(name);
  return language ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : hljs.highlightAuto(source).value;
}

export { hljs };
