import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileTypeFromFile } from 'file-type';
const images = new Set(['png', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'ico']);
export async function identifyFile(file) {
  let detected;
  try { detected = await fileTypeFromFile(file); }
  catch (error) { if (error.name !== 'EndOfStreamError') throw error; }
  if (detected) return { type: detected.ext === 'pdf' ? 'pdf' : images.has(detected.ext) ? 'image' : 'binary', format: detected.ext, mime: detected.mime };
  const bytes = await readFile(file);
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { type: 'binary', mime: 'application/octet-stream' }; }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(source)) return { type: 'binary', mime: 'application/octet-stream' };
  const extension = extname(file).toLowerCase();
  const svg = /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg(?:\s|>)/i.test(source);
  return { type: svg ? 'image' : extension === '.md' ? 'markdown' : extension === '.typ' ? 'typst' : 'text', mime: svg ? 'image/svg+xml' : 'text/plain; charset=utf-8', source };
}
