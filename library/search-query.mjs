// Shared by the browser and service so qualifier edits and filtering agree.
function unquote(value) {
  return value.replace(/\\(["\\])/g, '$1');
}

export function queryTokens(query) {
  const tokens = [];
  let index = 0;
  while (index < query.length) {
    while (/\s/.test(query[index] || '') && index < query.length) index++;
    if (index >= query.length) break;
    const start = index;
    const qualifier = /^(lang|language|path|case):/i.exec(query.slice(index));
    const kind = qualifier ? (qualifier[1].toLowerCase() === 'language' ? 'lang' : qualifier[1].toLowerCase()) : 'text';
    if (qualifier) index += qualifier[0].length;
    if (!qualifier && query[index] === '/') {
      index++;
      let value = '', closed = false, inClass = false;
      while (index < query.length) {
        const char = query[index++];
        if (char === '\\' && index < query.length) {
          const escaped = query[index++];
          value += escaped === '/' ? '/' : char + escaped;
        } else if (char === '/' && !inClass) { closed = true; break; }
        else {
          if (char === '[') inClass = true;
          if (char === ']') inClass = false;
          value += char;
        }
      }
      if (!closed) throw new Error('Close the regular expression with /. Quote slash-prefixed text to search it literally.');
      let flags = '';
      while (index < query.length && !/\s/.test(query[index])) flags += query[index++];
      if (flags !== '' && flags !== 'i') throw new Error('Only the i flag is supported: /pattern/ or /pattern/i.');
      if (!value) throw new Error('Enter a non-empty regular expression between the slashes.');
      try { new RegExp(value, flags + 'u'); }
      catch (error) { throw new Error(`Invalid regular expression: ${error.message}`); }
      tokens.push({ kind: 'regex', value, flags, raw: query.slice(start, index) });
      continue;
    }
    const quoted = query[index] === '"';
    let value = '';
    if (quoted) {
      index++;
      let closed = false;
      while (index < query.length) {
        if (query[index] === '\\' && /["\\]/.test(query[index + 1] || '')) { value += query.slice(index, index + 2); index += 2; }
        else if (query[index] === '"') { index++; closed = true; break; }
        else value += query[index++];
      }
      if (!closed) throw new Error('Close the quotation mark in your search query.');
      if (index < query.length && !/\s/.test(query[index])) throw new Error('Separate search terms and filters with a space.');
    } else {
      while (index < query.length && !/\s/.test(query[index])) value += query[index++];
    }
    if (qualifier && !value) throw new Error(`Enter a value after ${kind}:`);
    tokens.push({ kind, value: unquote(value), quoted, raw: query.slice(start, index) });
  }
  return tokens;
}

export function parseSearchQuery(query) {
  const tokens = queryTokens(query);
  const caseToken = tokens.findLast(token => token.kind === 'case');
  if (caseToken && !['yes', 'no'].includes(caseToken.value)) throw new Error('Use case:yes or case:no.');
  const regex = tokens.find(token => token.kind === 'regex');
  if (regex && tokens.filter(token => ['regex', 'text'].includes(token.kind)).length !== 1)
    throw new Error('Use one regular expression with optional lang/path filters; quote text for a literal search.');
  return { ...(regex ? { regex: true, caseSensitive: regex.flags !== 'i' } : {}), ...(!regex && caseToken ? { caseSensitive: caseToken.value === 'yes' } : {}), text: regex ? regex.value : tokens.filter(token => token.kind === 'text').map(token => token.value).join(' '),
    languages: tokens.filter(token => token.kind === 'lang').map(token => token.value),
    paths: tokens.filter(token => token.kind === 'path').map(({ value, quoted }) => ({ value, quoted })) };
}

export function updateQueryQualifier(query, kind, value) {
  if (kind === 'language') kind = 'lang';
  const remaining = queryTokens(query).filter(token => token.kind !== kind).map(token => token.raw);
  if (value) {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    remaining.push(`${kind}:${/\s|["\\*?]/.test(value) ? `"${escaped}"` : value}`);
  }
  return remaining.join(' ');
}

const aliases = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust', cpp: 'c++', cplusplus: 'c++', sh: 'shell', bash: 'shell', md: 'markdown', yml: 'yaml', plain: 'text', plaintext: 'text' };
export function normalizeLanguage(value) {
  const lower = value.toLowerCase().replace(/[ -]/g, '');
  return aliases[lower] || lower;
}
export function languageMatches(language, filters) {
  return filters.every(value => normalizeLanguage(value) === normalizeLanguage(language));
}

export function pathMatches(path, filters) {
  return filters.every(({ value, quoted }) => {
    if (quoted || !/[*?]/.test(value)) return path.toLowerCase().includes(value.toLowerCase());
    const anchored = value.startsWith('/');
    if (anchored) value = value.slice(1);
    let pattern = '';
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === '*' && value[index + 1] === '*') {
        index++;
        if (value[index + 1] === '/') { pattern += '(?:.*/)?'; index++; }
        else pattern += '.*';
      } else if (char === '*') pattern += '[^/]*';
      else if (char === '?') pattern += '[^/]';
      else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${anchored ? '^' : '(?:^|/)'}${pattern}$`, 'i').test(path);
  });
}

export function cardMatchLines(file, expanded, limit = 5) {
  const lines = file.snippets.flatMap(snippet => snippet.lines).filter(line => line.ranges.length);
  return expanded ? lines : lines.slice(0, limit);
}
