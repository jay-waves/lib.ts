import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, sep, isAbsolute, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export function packageRoot(namespace) {
  return resolve(namespace === 'local' ? process.env.APPDATA || '' : process.env.LOCALAPPDATA || '', 'typst/packages', namespace);
}

export function createTypstRuntime({ emit, memorySample, unvirtual }) {
  let runtimePromise;
  let fontsPromise;
  let runtimeValue;

  async function loadMissingPreviewPackage(name, version) {
    const path = resolve(packageRoot('preview'), name, version);
    if (existsSync(path)) return true;
    const spec = `@preview/${name}:${version}`;
    try {
      if (!/^[a-z0-9-]+$/i.test(name) || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Error('invalid package name or version');
      const response = await fetch(`https://packages.typst.org/preview/${name}-${version}.tar.gz`);
      if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);
      const compressed = Buffer.from(await response.arrayBuffer());
      if (compressed.length > 32 * 1024 * 1024) throw new Error('package archive exceeds 32 MiB');
      const archive = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
      const parent = dirname(path);
      await mkdir(parent, { recursive: true });
      const staging = resolve(parent, `.download-${randomBytes(8).toString('hex')}`);
      await mkdir(staging);
      try {
        await extractTypstTar(archive, staging);
        if (!existsSync(resolve(staging, 'typst.toml'))) throw new Error('package archive has no typst.toml');
        try { await rename(staging, path); }
        catch (error) { if (!existsSync(path)) throw error; }
      } finally { await rm(staging, { recursive: true, force: true }); }
      return existsSync(path);
    } catch (error) {
      emit({ event: 'notice', kind: 'typst', message: `Could not download ${spec}: ${error.message}` });
      return false;
    }
  }

  async function extractTypstTar(archive, destination) {
    let offset = 0;
    let extendedPath;
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) return;
      const textField = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
      const size = Number.parseInt(textField(124, 12).trim() || '0', 8);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid tar entry size');
      const type = String.fromCharCode(header[156] || 48);
      const headerName = [textField(345, 155), textField(0, 100)].filter(Boolean).join('/');
      const rawName = (extendedPath || headerName).replace(/^\.\//, '');
      extendedPath = undefined;
      const rel = rawName.replace(/\\/g, '/').replace(/\/$/, '');
      const target = resolve(destination, rel);
      const relativeTarget = relative(destination, target);
      if ((type !== '5' && !rel) || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget))
        throw new Error('archive contains an unsafe path');
      const dataStart = offset + 512;
      const dataEnd = dataStart + size;
      if (dataEnd > archive.length) throw new Error('truncated tar archive');
      if (type === 'x' || type === 'g') {
        const pax = archive.subarray(dataStart, dataEnd).toString('utf8');
        for (const record of pax.split('\n')) {
          const match = record.match(/^\d+ ([^=]+)=(.*)$/);
          if (match?.[1] === 'path') extendedPath = match[2];
        }
      } else if (type === '0' || type === '\0') {
        if (size > 32 * 1024 * 1024) throw new Error('package file exceeds 32 MiB');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, archive.subarray(dataStart, dataEnd), { flag: 'wx' });
      } else if (type === '5') await mkdir(target, { recursive: true });
      else throw new Error(`unsupported tar entry type ${type}`);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (offset > archive.length) throw new Error('truncated tar archive');
  }

  async function init() {
    if (runtimeValue) return runtimeValue;
    if (!runtimePromise) runtimePromise = (async () => {
      const [{ createTypstCompiler, createTypstFontBuilder, CompileFormatEnum }, { createTypstRenderer },
        { loadFonts, withAccessModel, withPackageRegistry }] = await Promise.all([
        import('@myriaddreamin/typst.ts/compiler'), import('@myriaddreamin/typst.ts/renderer'),
        import('@myriaddreamin/typst.ts/dist/esm/options.init.mjs'),
      ]);
      const compiler = createTypstCompiler();
      const renderer = createTypstRenderer();
      const access = {
        getMTime(path) { try { return new Date(statSync(unvirtual(path)).mtimeMs); } catch { return undefined; } },
        isFile(path) { const file = unvirtual(path); try { return file ? statSync(file).isFile() : undefined; } catch { return false; } },
        getRealPath(path) { return unvirtual(path); },
        readAll(path) { const file = unvirtual(path); try { return file ? new Uint8Array(readFileSync(file)) : undefined; } catch { return undefined; } },
      };
      const registry = { resolve(spec) {
        if (!['local', 'preview'].includes(spec.namespace)) return undefined;
        const path = resolve(packageRoot(spec.namespace), spec.name, spec.version);
        return existsSync(path) ? `/packages/${spec.namespace}/${spec.name}/${spec.version}` : undefined;
      } };
      memorySample('before-wasm-init');
      await compiler.init({
        getModule: () => ({ module_or_path: readFileSync(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-web-compiler/wasm'))) }),
        beforeBuild: [loadFonts([], { assets: false }), withAccessModel(access), withPackageRegistry(registry)],
      });
      await renderer.init({ getModule: () => ({ module_or_path: readFileSync(fileURLToPath(import.meta.resolve('@myriaddreamin/typst-ts-renderer/wasm'))) }) });
      memorySample('wasm-ready');
      runtimeValue = { compiler, renderer, createTypstFontBuilder, CompileFormatEnum };
      return runtimeValue;
    })().catch(error => { runtimePromise = undefined; throw error; });
    return runtimePromise;
  }

  async function initFonts() {
    if (fontsPromise) return fontsPromise;
    fontsPromise = (async () => {
      const runtime = await init();
      const windowsFonts = `${process.env.WINDIR || 'C:/Windows'}/Fonts`;
      const userFonts = `${process.env.LOCALAPPDATA || ''}/Microsoft/Windows/Fonts`;
      const defaults = [`${windowsFonts}/arial.ttf`, `${windowsFonts}/cambria.ttc`, `${windowsFonts}/CascadiaMono.ttf`,
        `${windowsFonts}/cour.ttf`, `${windowsFonts}/courbd.ttf`, `${windowsFonts}/couri.ttf`, `${windowsFonts}/courbi.ttf`,
        ...['NewCMMath-Book.otf', 'NewCMMath-Regular.otf', 'NewCMMath-Bold.otf']
          .flatMap(name => [`${userFonts}/${name}`, `${windowsFonts}/${name}`]),
        ...['LibertinusSerif-Regular.otf', 'LibertinusSerif-Italic.otf', 'LibertinusSerif-Semibold.otf',
          'LibertinusSans-Regular.otf', 'LibertinusSans-Italic.otf', 'SourceHanSansCN-VF.otf',
          'SourceHanSansCN-Medium.otf', 'SourceHanSansCN-Regular.otf', 'SourceHanSerifCN-VF.otf',
          'SourceHanSerifCN-Bold.otf', 'SourceHanSerifCN-SemiBold.otf', 'SourceHanSerifCN-Medium.otf',
          'SourceHanSerifCN-Regular.otf'].map(name => `${userFonts}/${name}`), `${userFonts}/FiraCode-Regular.ttf`];
      const fonts = [...new Set((process.env.TYPST_WASM_FONTS ? process.env.TYPST_WASM_FONTS.split(';') : defaults).filter(existsSync))];
      memorySample('before-fonts-init', { fontCount: fonts.length });
      const builder = runtime.createTypstFontBuilder();
      await builder.init();
      for (const file of fonts) {
        // Yield between fonts so startup prewarming can coexist with HTTP requests.
        const data = new Uint8Array(await readFile(file));
        if (extname(file).toLowerCase() !== '.ttc' && data.byteLength >= 4 * 1024 * 1024) {
          try {
            const info = await builder.getFontInfo(data);
            await builder.addLazyFont(info, () => new Uint8Array(readFileSync(file)));
            continue;
          } catch (error) { emit({ event: 'notice', kind: 'typst', message: `Could not register lazy font ${file}: ${error}` }); }
        }
        await builder.addFontData(data);
      }
      await builder.build(async resolver => runtime.compiler.setFonts(resolver));
      memorySample('fonts-ready', { fontCount: fonts.length });
    })().catch(error => { fontsPromise = undefined; throw error; });
    return fontsPromise;
  }

  return { init, initFonts, loadMissingPreviewPackage, get value() { return runtimeValue; } };
}
