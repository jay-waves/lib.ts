import { parentPort, workerData } from 'node:worker_threads';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { ripgrep } from 'ripgrep';
import { MAX_FILE, MAX_BYTES, MAX_FILES, MAX_RESULT_BYTES, searchFileBytes, ignored, binaryExtensions, decodeSearchText, searchLanguage, searchSnippets } from './search-core.mjs';

async function scan({ root, query, caseSensitive, excludedDirectory, regex, allowedPaths = null }) {
  root = await realpath(root);
  let candidates;
  if (allowedPaths !== null) candidates = allowedPaths.map(path => resolve(root, path)).sort();
  else {
    // Regex candidates are enumerated, then matched by the same JS engine that
    // generates snippets. This avoids Rust/JS regex differences dropping results.
    const args = ['--no-config', '--no-ignore', ...(regex ? ['--files'] : ['--files-with-matches', '--fixed-strings']), '--null', '--max-filesize', String(MAX_FILE),
      ...(caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
      '-g', '!**/node_modules/**', '-g', '!**/.work/**', '-g', '!**/.archive/**', '--', ...(regex ? [root] : [query, root])];
    const chunks = [];
    let stderr = '', outputBytes = 0;
    const result = await ripgrep(args, { nodeWasi: false, env: {}, preopens: { '.': root },
      stdout: { write(chunk) {
        outputBytes += chunk.length;
        if (outputBytes > 1024 * 1024) throw new Error('Too many candidate files. Try a more specific query.');
        chunks.push(Buffer.from(chunk));
      } },
      stderr: { write(chunk) { stderr = (stderr + Buffer.from(chunk).toString('utf8')).slice(0, 2000); } },
    });
    if (result.code !== 0 && result.code !== 1) throw new Error(stderr || 'ripgrep search failed');
    const output = Buffer.concat(chunks).toString('utf8');
    candidates = output.split('\0').filter(Boolean).sort();
  }
  const files = [];
  let bytes = 0, resultBytes = 0, truncated = false;
  for (const candidate of candidates) {
    const file = resolve(root, candidate);
    const path = relative(root, file).replace(/\\/g, '/');
    if (path.split('/').some(part => part.startsWith('.') || ignored.has(part))) continue;
    if (binaryExtensions.has(extname(path).toLowerCase())) continue;
    if (isAbsolute(path) || path === '..' || path.startsWith('../')) continue;
    try {
      const actualFile = await realpath(file);
      if (excludedDirectory) {
        const excludedPath = relative(excludedDirectory, actualFile);
        if (!isAbsolute(excludedPath) && excludedPath !== '..' && !excludedPath.startsWith('../') && !excludedPath.startsWith('..\\')) continue;
      }
      const actualPath = relative(root, actualFile);
      if (actualPath === '..' || actualPath.startsWith('..\\') || actualPath.startsWith('../') || isAbsolute(actualPath)) continue;
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_FILE) continue;
      if (bytes + info.size > MAX_BYTES) { truncated = true; break; }
      bytes += info.size;
      const buffer = await readFile(file);
      if (buffer.length > MAX_FILE) continue;
      const text = decodeSearchText(buffer);
      if (text === null) continue;
      const matches = searchSnippets(text, query, caseSensitive, regex);
      if (!matches.matchCount) continue;
      const entry = { path, language: searchLanguage(path), ...matches };
      const weight = searchFileBytes(entry);
      if (resultBytes + weight > MAX_RESULT_BYTES) { truncated = true; break; }
      resultBytes += weight;
      files.push(entry);
      if (files.length >= MAX_FILES) { truncated = true; break; }
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, resultBytes, engine: allowedPaths === null ? 'ripgrep-wasm' : 'selected-files', truncated, time: Date.now() };
}

try { parentPort.postMessage({ result: await scan(workerData) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }
