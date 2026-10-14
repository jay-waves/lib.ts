import { extname } from 'node:path';

export const MAX_FILE = 2 * 1024 * 1024;
export const MAX_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 1000;
export const MAX_SNIPPET_LINES = 10;
export const MAX_LINE_RANGES = 24;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
// Conservative accounting for retained JS strings, arrays and result objects.
// This is a cache budget, not a process-wide memory limit.
export function searchFileBytes(file) {
  return 512 + file.path.length * 2 + file.snippets.reduce((bytes, snippet) => bytes + 128 +
    snippet.lines.reduce((sum, line) => sum + 512 + line.text.length * 2 + line.ranges.length * 80, 0), 0);
}
export const ignored = new Set(['node_modules', '.git', '.work', '.archive']);
export const binaryExtensions = new Set(['.pdf', '.zip', '.gz', '.7z', '.rar', '.tar', '.xz', '.bz2', '.exe', '.dll', '.so', '.dylib', '.wasm', '.node', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.mp3', '.mp4', '.mov', '.wav', '.flac', '.ogg', '.woff', '.woff2', '.ttf', '.otf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.epub', '.sqlite', '.db']);
const languages = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', py: 'Python', rs: 'Rust', go: 'Go', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', java: 'Java', lua: 'Lua', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', pwsh: 'PowerShell', md: 'Markdown', typ: 'Typst', json: 'JSON', css: 'CSS', html: 'HTML', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG', rb: 'Ruby', php: 'PHP', sql: 'SQL' };
export function searchLanguage(path) { return languages[extname(path).slice(1).toLowerCase()] || 'Text'; }

export function decodeSearchText(buffer) {
  // Check the entire file: a NUL after an early match still makes it binary.
  if (buffer.includes(0)) return null;
  const header = buffer.subarray(0, 8).toString('latin1');
  if (/^(?:%PDF-|PK\x03\x04|PK\x05\x06|PK\x07\x08|GIF8[79]a|\x89PNG|\xff\xd8\xff|BM|\x7fELF|wOFF|wOF2)/.test(header)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text) ? null : text;
  } catch { return null; }
}

export function searchSnippets(text, query, caseSensitive = false, regex = false) {
  if (!query) return { matchCount: 0, snippets: [], snippetsTruncated: false };
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(regex ? query : escaped, caseSensitive ? 'gu' : 'giu');
  const lines = text.split(/\r?\n/);
  const hits = new Map();
  let matchCount = 0, hitLines = 0, clippedMatches = false;
  for (let index = 0; index < lines.length; index++) {
    const ranges = [];
    let count = 0, offset = 0;
    for (const match of lines[index].matchAll(pattern)) {
      count++;
      if (count === 1) offset = Math.max(0, match.index - 200);
      if (hits.size < MAX_SNIPPET_LINES && match.index < offset + 1200) {
        const end = match.index + match[0].length;
        const previous = ranges.at(-1);
        // Adjacent matches need one highlight span, not one array per character.
        if (previous && previous[1] === match.index && previous[0] !== previous[1] && end > match.index) previous[1] = end;
        else if (ranges.length < MAX_LINE_RANGES) ranges.push([match.index, end]);
        else clippedMatches = true;
      } else clippedMatches = true;
    }
    if (count) {
      hitLines++; matchCount += count;
      if (hits.size < MAX_SNIPPET_LINES) hits.set(index, ranges);
    }
  }
  // Retain only matching rows; distant matches stay separate within one file card.
  const snippets = [];
  for (const [index, ranges] of hits) {
    const offset = Math.max(0, (ranges[0]?.[0] || 0) - 200);
    // Detach excerpts from V8 sliced strings, which can otherwise retain the
    // entire source file through a tiny excerpt. UTF-16 preserves range offsets.
    const content = Buffer.from(lines[index].slice(offset, offset + 1200), 'utf16le').toString('utf16le');
    const line = { number: index + 1, text: content,
      clipped: offset > 0 || lines[index].length > offset + content.length,
      ranges: ranges.filter(([a, b]) => a === b ? a >= offset && a <= offset + content.length : a < offset + content.length && b > offset)
        .map(([a, b]) => [Math.max(0, a - offset), Math.min(content.length, b - offset)]) };
    const last = snippets.at(-1);
    if (last && index + 1 - last.lines.at(-1).number <= 5) last.lines.push(line);
    else snippets.push({ lines: [line] });
  }
  return { matchCount, snippets, snippetsTruncated: clippedMatches || hits.size < hitLines };
}
