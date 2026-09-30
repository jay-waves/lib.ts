import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/',
  esbuild: { legalComments: 'eof' },
  plugins: [{
    name: 'inline-markdown-template',
    transformIndexHtml(html, context) {
      if (!context.path.endsWith('/markdown/index.html')) return;
      const fragments = {
        '__MARKDOWN_THEME_CSS__': 'theme.css',
        '__HIGHLIGHT_THEME_CSS__': 'highlight.css',
        '__SIDENOTES_CSS__': 'sidenotes.css',
      };
      for (const [placeholder, file] of Object.entries(fragments)) {
        html = html.replace(placeholder, readFileSync(resolve(here, 'src/markdown', file), 'utf8'));
      }
      return html;
    },
  }],
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        markdown: resolve(here, 'src/markdown/index.html'),
        typst: resolve(here, 'src/typst/index.html'),
        library: resolve(here, 'library/index.html'),
        viewer: resolve(here, 'library/viewer.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
