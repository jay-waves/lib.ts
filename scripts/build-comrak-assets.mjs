import { build } from 'esbuild';
import * as d3 from 'd3';
import { mkdir, readFile, writeFile, readdir, cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'crates/lib-comrak/generated');
await mkdir(resolve(output, 'fonts'), { recursive: true });
await build({ entryPoints: [resolve(root, 'crates/lib-comrak/navigation.mjs')], outfile: resolve(output, 'navigation.js'), bundle: true, format: 'iife', platform: 'browser', target: 'es2020', minify: true });
await build({
  entryPoints: [resolve(root, 'crates/lib-comrak/render.mjs')],
  outfile: resolve(output, 'render.js'), bundle: true, format: 'iife',
  platform: 'neutral', mainFields: ['module', 'main'], target: 'es2020',
  // Syntax minification merges declarations into deeply nested expressions.
  // Keep the parser stack bounded when QuickJS compiles the bundle on Windows.
  minifyWhitespace: true, minifyIdentifiers: true, minifySyntax: false,
  legalComments: 'inline',
});
const moduleSource = Object.keys(d3).map(name => `export const ${name}=globalThis.__vizD3.${name};`).join('\n');
await writeFile(resolve(output, 'd3-module.js'), moduleSource);
await build({
  stdin: { contents: "import * as d3 from 'd3'; globalThis.__vizD3 = d3;", resolveDir: root },
  outfile: resolve(output, 'viz.js'), bundle: true, format: 'iife', platform: 'browser',
  target: 'es2020', minify: true, legalComments: 'inline',
});
let theme = await readFile(resolve(root, 'web/markdown/theme.css'), 'utf8');
// Use system text and monospace fonts in the standalone compiler.
theme = theme.replace(/@font-face\s*\{[^}]*font-family:\s*"(?:Iosevka|Lib Source Han Serif)";[^}]*\}/g, '');
let highlight = await readFile(resolve(root, 'web/markdown/highlight.css'), 'utf8');
highlight = highlight.replace('@scope (.reader, .code-search-results)', '@scope (#content)');
const css = [theme, highlight,
  await readFile(resolve(root, 'web/markdown/heading-sections.css'), 'utf8'),
  await readFile(resolve(root, 'node_modules/katex/dist/katex.min.css'), 'utf8'),
  await readFile(resolve(root, 'crates/lib-comrak/style.css'), 'utf8'),
].join('\n');
const sourceFonts = (await readdir(resolve(root, 'node_modules/katex/dist/fonts')))
  .filter(name => name.endsWith('.woff2'));
// Remove only obsolete generated fonts, leaving source assets untouched.
for (const name of await readdir(resolve(output, 'fonts'))) {
  if (!sourceFonts.includes(name)) await rm(resolve(output, 'fonts', name), { recursive: true });
}
for (const name of sourceFonts) {
  if (name.endsWith('.woff2')) await cp(resolve(root, 'node_modules/katex/dist/fonts', name), resolve(output, 'fonts', name));
}
// Keep only the preferred format. Every emitted font URL has an embedded asset.
const compact = css.replace(/src:([^;}]+)/g, (declaration, sources) => {
  const preferred = sources.match(/url\(([^)]*\.woff2)\)/);
  return preferred ? `src:url(${preferred[1]}) format("woff2")` : declaration;
});
await writeFile(resolve(output, 'style.css'), compact);
const vizCss = await readFile(resolve(root, 'crates/lib-comrak/d3.css'), 'utf8');
await writeFile(resolve(output, 'd3.css'), vizCss);
const mermaidCss = await readFile(resolve(root, 'crates/lib-comrak/mermaid.css'), 'utf8');
await writeFile(resolve(output, 'mermaid.css'), mermaidCss);
const hash = createHash('sha256').update(compact).update(vizCss);
hash.update(moduleSource).update(await readFile(resolve(output, 'viz.js'))).update(mermaidCss);
hash.update(await readFile(resolve(output, 'navigation.js')));
for (const name of (await readdir(resolve(output, 'fonts'))).sort()) {
  hash.update(name).update(await readFile(resolve(output, 'fonts', name)));
}
await writeFile(resolve(output, 'version.txt'), hash.digest('hex').slice(0, 16));
for (const [name, path] of [
  ['KaTeX-LICENSE', 'node_modules/katex/LICENSE'],
  ['highlight.js-LICENSE', 'node_modules/highlight.js/LICENSE'],
  ['D3-LICENSE', 'node_modules/d3/LICENSE'],
  ['LinkeDOM-LICENSE', 'node_modules/linkedom/LICENSE'],
  ['Pele-LICENSE', 'node_modules/pele/LICENSE'],
]) await cp(resolve(root, path), resolve(output, name));
console.log(`Prepared lib.comrak assets: ${output}`);
