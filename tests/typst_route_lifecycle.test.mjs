import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, relative, isAbsolute } from 'node:path';
import { createLibraryRoutes } from '../library/routes.mjs';

test('Typst page authorization follows the live cache and preserves repository boundaries', async () => {
  const root = resolve('notes');
  const documents = new Map([['local', resolve(root, 'a.typ')], ['foreign', resolve('other', 'b.typ')]]);
  let rendered = 0;
  const app = createLibraryRoutes({ root,
    json: (value, status = 200) => Response.json(value, { status }),
    typstFile: id => documents.get(id),
    checkedPath(file) {
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Outside repo');
      return file;
    },
    typstPage: () => { rendered++; return new Response('<svg/>'); },
  });
  assert.equal((await app.request('/api/typst/page?id=local&page=1')).status, 200);
  assert.equal((await app.request('/api/typst/page?id=foreign&page=1')).status, 410);
  documents.delete('local');
  assert.equal((await app.request('/api/typst/page?id=local&page=1')).status, 410);
  assert.equal(rendered, 1);
});
