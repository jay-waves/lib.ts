import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { parseSearchQuery, languageMatches, pathMatches } from './search-query.mjs';
import { MAX_FILES } from './search-core.mjs';
import { createSearchCache } from './search-cache.mjs';
export { decodeSearchText, searchSnippets } from './search-core.mjs';

function scan(root, query, caseSensitive, excludedDirectory, regex, allowedPaths = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./search-worker.mjs', import.meta.url), { workerData: { root, query, caseSensitive, excludedDirectory, regex, allowedPaths }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Search timed out. Try a more specific query.'));
    }, 15000);
    let answered = false;
    worker.once('message', message => {
      answered = true;
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error));
      else resolve({ ...message.result, id: randomUUID() });
    });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timeout);
      if (!answered) reject(new Error(`Search worker exited (${code})`));
    });
  });
}

export function createLibrarySearch(root, excludedDirectory, getSearchPaths) {
  const cache = createSearchCache();
  const pending = new Map();
  return async function search(params) {
    const input = (params.get('q') || '').trim();
    const parsed = parseSearchQuery(input);
    const query = parsed.text;
    if (!query || input.length > 256 || /[\r\n\0]/.test(input)) throw new Error('Enter a single-line search query of 1–256 characters.');
    const caseSensitive = parsed.caseSensitive ?? (params.get('case') === 'true');
    const scope = params.get('scope') || 'files';
    if (!['files', 'bookmarks', 'current-file'].includes(scope) || params.getAll('scope').length > 1)
      throw new Error('Choose one search scope: files, bookmarks or current-file.');
    const currentFile = params.get('currentFile') || '';
    if (scope === 'current-file' && (!currentFile || /[\\\0:]/.test(currentFile)
      || currentFile.split('/').some(part => !part || part === '.' || part === '..')))
      throw new Error('Choose a repository-relative current file.');
    const identity = JSON.stringify([query, caseSensitive, !!parsed.regex, scope, scope === 'current-file' ? currentFile : null]);
    const searchId = params.get('searchId');
    // Paging retains the original membership even if a bookmark/tab changes.
    const allowedPaths = searchId || scope === 'files' ? null : scope === 'current-file'
      ? [currentFile] : [...new Set(await getSearchPaths?.(scope) || [])].sort();
    const key = JSON.stringify([identity, allowedPaths]);
    for (const [id, value] of cache) if (Date.now() - value.time > 300000) cache.delete(id);
    let result = searchId ? cache.get(searchId) : [...cache.values()].reverse().find(value => value.key === key);
    if (result && (searchId ? result.identity !== identity : result.key !== key)) result = null;
    if (searchId && (!result || Date.now() - result.time > 300000)) throw new Error('Search expired. Run the search again.');
    if (!searchId && (!result || Date.now() - result.time > 60000 || params.get('refresh') === 'true')) {
      if (!pending.has(key)) {
        if (pending.size >= 2) throw new Error('Search is busy. Please retry shortly.');
        pending.set(key, scan(root, query, caseSensitive, excludedDirectory, !!parsed.regex, allowedPaths).finally(() => pending.delete(key)));
      }
      result = await pending.get(key);
      result.key = key; result.identity = identity;
      cache.set(result.id, result);
    }
    const language = params.get('lang') || params.get('language') || '', path = params.get('path') || '';
    const languages = [...parsed.languages, ...(language ? [language] : [])];
    const paths = parsed.paths;
    const matchesPath = file => pathMatches(file.path, paths) && (!path || (path.endsWith('/') ? file.path.startsWith(path) : file.path === path));
    const matchesLanguage = file => languageMatches(file.language, languages);
    const matches = result.files.filter(file => matchesLanguage(file) && matchesPath(file));
    const preferred = params.get('currentFile');
    matches.sort((a, b) => Number(b.path === preferred) - Number(a.path === preferred) || a.path.localeCompare(b.path));
    const facet = values => [...values.reduce((map, value) => map.set(value, (map.get(value) || 0) + 1), new Map())]
      .map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const offset = Math.max(0, Math.min(MAX_FILES, Math.floor(Number(params.get('offset'))) || 0));
    const page = matches.slice(offset, offset + 20);
    return { query: input, textQuery: query, scope, searchId: result.id, engine: result.engine, truncated: result.truncated, total: matches.length,
      matchCount: matches.reduce((count, file) => count + file.matchCount, 0), files: page,
      nextOffset: offset + page.length < matches.length ? offset + page.length : null,
      facets: { languages: facet(result.files.filter(matchesPath).map(file => file.language)),
        paths: facet(result.files.filter(matchesLanguage).map(file => file.path.includes('/') ? file.path.split('/')[0] + '/' : file.path)) } };
  };
}
