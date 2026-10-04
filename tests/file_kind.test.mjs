import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifyFile } from '../library/file-kind.mjs';

test('content detection separates binary formats from text regardless of extension', async t => {
  const root = await mkdtemp(join(tmpdir(), 'file-kind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function detect(name, content) {
    const path = join(root, name);
    await writeFile(path, content);
    return identifyFile(path);
  }
  assert.equal((await detect('document.dat', '%PDF-1.7\n')).type, 'pdf');
  const gif = await detect('image.txt', Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex'));
  assert.equal(gif.type, 'image');
  assert.equal(gif.mime, 'image/gif');
  assert.equal((await detect('drawing', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime, 'image/svg+xml');
  assert.equal((await detect('note.md', '# 标题')).type, 'markdown');
  assert.equal((await detect('plain', '普通文本')).type, 'text');
  assert.equal((await detect('empty', '')).type, 'text');
  assert.equal((await detect('unknown.txt', Buffer.from([0, 1, 2, 3]))).type, 'binary');
  assert.equal((await detect('invalid.txt', Buffer.from([255, 254, 128]))).type, 'binary');
  const zip = await detect('archive', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'));
  assert.equal(zip.type, 'binary');
  assert.equal(zip.format, 'zip');
});
