import { readFile, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

// Native fontArgs accepts files, not the WASM resolver's family aliases.
// Keep the existing SC names as lazy file-backed aliases; do not retain CJK
// fontBlobs in JS/native memory at startup.
export function aliasFont(data) {
  const tables = data.readUInt16BE(4);
  let nameRecord, headRecord;
  for (let i = 0; i < tables; i++) {
    const at = 12 + 16 * i, tag = data.toString('ascii', at, at + 4);
    if (tag === 'name') nameRecord = at;
    if (tag === 'head') headRecord = at;
  }
  if (nameRecord === undefined || headRecord === undefined) throw new Error('Invalid bundled SFNT font');
  const old = data.subarray(data.readUInt32BE(nameRecord + 8),
    data.readUInt32BE(nameRecord + 8) + data.readUInt32BE(nameRecord + 12));
  if (old.readUInt16BE(0) !== 0) throw new Error('Unsupported bundled font name table');
  const count = old.readUInt16BE(2), stringOffset = old.readUInt16BE(4);
  const names = Buffer.from(old.subarray(0, 6 + 12 * count)), strings = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const at = 6 + 12 * i, platform = old.readUInt16BE(at), id = old.readUInt16BE(at + 6);
    const original = old.subarray(stringOffset + old.readUInt16BE(at + 10),
      stringOffset + old.readUInt16BE(at + 10) + old.readUInt16BE(at + 8));
    const unicode = platform === 0 || platform === 3;
    let text = unicode ? Buffer.from(original).swap16().toString('utf16le') : original.toString('latin1');
    if ([1, 4, 6, 16].includes(id)) text = text.replace(/ ?CN\b/g, '') + (id === 6 ? '-SC' : ' SC');
    const value = unicode ? Buffer.from(text, 'utf16le').swap16() : Buffer.from(text, 'latin1');
    names.writeUInt16BE(value.length, at + 8);
    names.writeUInt16BE(offset, at + 10);
    strings.push(value); offset += value.length;
  }
  names.writeUInt16BE(names.length, 4);
  const table = Buffer.concat([names, ...strings]);
  const start = Math.ceil(data.length / 4) * 4;
  const output = Buffer.alloc(start + Math.ceil(table.length / 4) * 4);
  data.copy(output); table.copy(output, start);
  function checksum(bytes) {
    let sum = 0;
    for (let i = 0; i < bytes.length; i += 4) sum = (sum + bytes.readUInt32BE(i)) >>> 0;
    return sum;
  }
  output.writeUInt32BE(start, nameRecord + 8);
  output.writeUInt32BE(table.length, nameRecord + 12);
  output.writeUInt32BE(checksum(output.subarray(start)), nameRecord + 4);
  const adjustment = output.readUInt32BE(headRecord + 8) + 8;
  output.writeUInt32BE(0, adjustment);
  output.writeUInt32BE((0xB1B0AFBA - checksum(output)) >>> 0, adjustment);
  return output;
}

export async function nativeFontPaths(files, directory = resolve(process.env.LOCALAPPDATA || tmpdir(), 'markdown-preview', 'typst-font-aliases')) {
  const paths = [...files];
  for (const file of files) {
    if (!/^SourceHan(?:Serif|Sans)/.test(basename(file))) continue;
    const info = await stat(file);
    const key = createHash('sha256').update(`2:${file}:${info.size}:${info.mtimeMs}`).digest('hex');
    const target = resolve(directory, `${key}.otf`);
    if (!await stat(target).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      await mkdir(directory, { recursive: true });
      const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, aliasFont(await readFile(file)));
        try { await rename(temporary, target); }
        catch (error) { if (!await stat(target).catch(() => null)) throw error; }
      } finally { await rm(temporary, { force: true }); }
    }
    paths.push(target);
  }
  return paths;
}
