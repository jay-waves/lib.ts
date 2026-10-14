import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const types = {
  '.avif': 'image/avif', '.css': 'text/css', '.gif': 'image/gif',
  '.html': 'text/html', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json',
  '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf', '.txt': 'text/plain', '.wasm': 'application/wasm',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.otf': 'font/otf', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

export async function fileResponse(path, headers = {}) {
  const info = await stat(path);
  if (!info.isFile()) return null;
  const content = await readFile(path);
  return new Response(content, {
    headers: { 'content-type': types[extname(path).toLowerCase()] || 'application/octet-stream', ...headers },
  });
}
