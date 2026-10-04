import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/',
  esbuild: { legalComments: 'eof' },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        library: resolve(here, 'library/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
