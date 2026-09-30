import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchLibraryFiles } from '../library/watch.mjs';

async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for a file change');
}

test('library watcher coalesces document changes and reports assets separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'library-watch-'));
  const document = join(root, 'note.md');
  const assetDirectory = join(root, 'images');
  const asset = join(assetDirectory, 'chart.svg');
  await mkdir(assetDirectory);
  await writeFile(document, 'before');
  await writeFile(asset, '<svg/>');
  const events = [];
  const stop = watchLibraryFiles(document, [asset], event => events.push(event));
  try {
    await writeFile(document, 'change one');
    await writeFile(document, 'change two');
    await waitFor(() => events.length === 1);
    assert.deepEqual(events[0], { documentChanged: true, assets: [] });

    await writeFile(asset, '<svg><rect/></svg>');
    await waitFor(() => events.length === 2);
    assert.deepEqual(events[1], { documentChanged: false, assets: [asset] });
  } finally {
    stop();
    await rm(root, { recursive: true, force: true });
  }
});
