import { readFileSync } from 'node:fs';
import { resolve, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler';
import { discoverTypstFonts } from './fonts.mjs';
import { nativeFontPaths } from './font-aliases.mjs';

export function packageRoot(namespace) {
  return resolve(namespace === 'local' ? process.env.APPDATA || '' : process.env.LOCALAPPDATA || '', 'typst/packages', namespace);
}

// Native compilation and WASM page rendering share the serialized worker.
export function createTypstRuntime({ memorySample = () => {} } = {}) {
  let runtimePromise, runtimeValue, workspace;
  async function init(file = process.cwd()) {
    const root = parse(resolve(file)).root;
    if (!runtimePromise) runtimePromise = (async () => {
      const { createTypstRenderer } = await import('@myriaddreamin/typst.ts/renderer');
      const renderer = createTypstRenderer();
      await renderer.init({ getModule: () => ({ module_or_path:
        readFileSync(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-renderer/wasm'))) }) });
      runtimeValue = { renderer, compiler: undefined };
      return runtimeValue;
    })().catch(error => { runtimePromise = undefined; throw error; });
    const runtime = await runtimePromise;
    if (workspace !== root) {
      runtime.compiler?.evictCache(0);
      memorySample('before-native-init');
      runtime.compiler = NodeCompiler.create({ workspace: root,
        fontArgs: [{ fontPaths: await nativeFontPaths(discoverTypstFonts()) }] });
      workspace = root;
      memorySample('native-ready');
    }
    return runtime;
  }
  return { init, get value() { return runtimeValue; } };
}
