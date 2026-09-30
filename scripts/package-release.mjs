import { execFileSync } from 'node:child_process';
import { readdir, readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'release');
const outputFile = join(outputDirectory, 'markdown-preview-nvim.zip');
const zipRoot = 'markdown-preview.nvim';

const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
execFileSync(process.execPath, [viteCli, 'build'], { cwd: root, stdio: 'inherit' });

const files = [];
async function addFile(source, archiveName) {
  const info = await stat(source);
  if (!info.isFile()) return;
  files.push({
    name: `${zipRoot}/${archiveName.split(sep).join('/')}`,
    data: await readFile(source),
    modified: info.mtime,
  });
}

async function addDirectory(source, archivePrefix = relative(root, source), skipNestedNodeModules = false) {
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (skipNestedNodeModules && entry.isDirectory() && entry.name === 'node_modules') continue;
    const path = join(source, entry.name);
    const archiveName = join(archivePrefix, entry.name);
    if (entry.isDirectory()) await addDirectory(path, archiveName, skipNestedNodeModules);
    else if (entry.isFile()) await addFile(path, archiveName);
  }
}

for (const file of ['README.md', 'LICENSE']) await addFile(join(root, file), file);
await addFile(join(root, 'scripts/package-release.mjs'), 'scripts/package-release.mjs');
for (const directory of ['plugin', 'lua', 'src', 'library']) {
  await addDirectory(join(root, directory));
}
await addDirectory(join(root, 'dist'));
for (const file of ['package.json', 'package-lock.json', 'vite.config.js', 'server-node.mjs',
  'file-response.mjs', 'markdown-preview.mjs', 'markdown-renderer.mjs', 'neovim-bridge.mjs',
  'typst-anchors.mjs', 'typst-compile.mjs', 'typst-pages.mjs', 'typst-runtime.mjs',
  'typst-tree.mjs']) {
  await addFile(join(root, file), file);
}
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
// The PDFium Node entry points do not import React. EmbedPDF declares these
// peers for its optional UI adapters; the library UI ships prebuilt under dist/.
const browserOnlyPeerDependencies = new Set([
  'node_modules/react', 'node_modules/react-dom', 'node_modules/scheduler',
]);
for (const [modulePath, metadata] of Object.entries(lock.packages)) {
  if (!modulePath.startsWith('node_modules/') || metadata.dev === true
    || browserOnlyPeerDependencies.has(modulePath)) continue;
  const source = join(root, modulePath);
  try {
    if ((await stat(source)).isDirectory()) {
      const archivePrefix = modulePath;
      if (/^node_modules\/@embedpdf\/fonts-[^/]+$/.test(modulePath)) {
        // EmbedPDF imports these packages for font metadata, but this server does not
        // configure external font fallback. Keep the modules; omit their large font files.
        for (const entry of await readdir(source, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name === 'fonts') continue;
          const path = join(source, entry.name);
          const archiveName = join(archivePrefix, entry.name);
          if (entry.isDirectory()) await addDirectory(path, archiveName, true);
          else if (entry.isFile()) await addFile(path, archiveName);
        }
      } else await addDirectory(source, archivePrefix, true);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

files.sort((a, b) => a.name.localeCompare(b.name));

function createZip(entries) {
  if (entries.length > 0xffff) throw new Error('ZIP32 cannot contain more than 65,535 files');
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    if (name.length > 0xffff || entry.data.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new Error(`ZIP32 entry is too large: ${entry.name}`);
    }
    if (localOffset > 0xffffffff) throw new Error('ZIP32 archive exceeds 4 GiB');
    const checksum = crc32(entry.data);
    const { time, date } = dosDateTime(entry.modified);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0o100644 * 0x10000, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const zip = createZip(files);
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputFile, zip);
console.log(`Created ${relative(root, outputFile)} (${zip.length.toLocaleString()} bytes, ${files.length} files)`);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}
