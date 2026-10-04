import { parseSearchQuery, languageMatches, pathMatches } from './search-query.mjs';

const languages = { md: 'Markdown', typ: 'Typst', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', go: 'Go', rs: 'Rust', lua: 'Lua', json: 'JSON', css: 'CSS', html: 'HTML', yml: 'YAML', yaml: 'YAML', sh: 'Shell', ps1: 'PowerShell', c: 'C', h: 'C', cpp: 'C++', java: 'Java', toml: 'TOML', rb: 'Ruby', php: 'PHP', sql: 'SQL', xml: 'XML', svg: 'SVG' };
export function filterSearchPaths(paths, query) {
  const parsed = parseSearchQuery(query);
  const regex = parsed.regex ? new RegExp(parsed.text, parsed.caseSensitive ? 'u' : 'iu') : null;
  const needle = parsed.caseSensitive ? parsed.text : parsed.text.toLocaleLowerCase();
  return [...new Set(paths)].map(path => ({ path, language: languages[path.split('.').at(-1).toLowerCase()] || 'Text' }))
    .filter(file => languageMatches(file.language, parsed.languages) && pathMatches(file.path, parsed.paths)
      && (regex ? regex.test(file.path) : (parsed.caseSensitive ? file.path : file.path.toLocaleLowerCase()).includes(needle)));
}
