import { readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const bundledFontsDirectory = fileURLToPath(new URL('../../fonts/', import.meta.url));

export function discoverTypstFonts(env = process.env) {
  // Application assets only: no system scans, package-font scans, or CDN requests.
  const override = env.TYPST_FONTS || env.TYPST_WASM_FONTS;
  const candidates = override ? override.split(';').map(file => file.trim()).filter(Boolean)
    : JSON.parse(readFileSync(resolve(bundledFontsDirectory, 'manifest.json'), 'utf8'))
      .map(name => resolve(bundledFontsDirectory, name));
  const seen = new Set();
  return candidates.map(file => resolve(file.trim())).filter(file => {
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key) || !['.otf', '.ttf', '.ttc'].includes(extname(file).toLowerCase())) return false;
    try { if (!statSync(file).isFile()) return false; }
    catch (error) {
      if (!override) throw new Error(`Bundled Typst font missing: ${file}`, { cause: error });
      return false;
    }
    seen.add(key);
    return true;
  });
}
