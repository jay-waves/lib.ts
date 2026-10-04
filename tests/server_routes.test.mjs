import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';

test('library-only service renders saved files and exposes external opening without editor routes', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'library-service-'));
  const root = resolve(temporary, 'notes');
  await mkdir(root);
  await writeFile(resolve(root, 'note.md'), '# Before\n\nText');
  await writeFile(resolve(root, 'note.typ'), '#set text(font: "Arial")\n#set heading(numbering: "1.")\n= First <first>\n\nSee @second.\n\n#link("https://example.com/?a=1&b=2")[External link]\n#pagebreak()\n= Second <second>\n\nSee @first.\n\nEnd');
  await writeFile(resolve(root, 'warning.typ'), '#set text(font: "Arial")\n#text(font: "UnavailableFont", "Fallback")');
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const server = spawn(process.execPath, [resolve('server-node.mjs'), root], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_PREVIEW_PORT: String(port), LIBRARY_DATA_DIRECTORY: resolve(temporary, 'data'),
      WASM_PREWARM: '0', TYPST_WASM_FONTS: `${process.env.WINDIR || 'C:/Windows'}/Fonts/arial.ttf` },
  });
  let output = '', errors = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await new Promise(done => server.once('exit', done));
    }
    await rm(temporary, { recursive: true, force: true });
  });
  const ready = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(errors || 'Service startup timed out')), 10000);
    server.once('error', error => { clearTimeout(timer); fail(error); });
    server.once('exit', code => { clearTimeout(timer); fail(new Error(`Service exited ${code}: ${errors}`)); });
    server.stdout.on('data', () => {
      const line = output.split('\n').find(line => line.includes('"event":"ready"'));
      if (line) { clearTimeout(timer); done(JSON.parse(line)); }
    });
  });
  const get = path => fetch(`${ready.baseUrl}${path}`);
  assert.equal((await get('/notes/tree/')).status, 200);
  assert.equal((await get('/notes/tree/note.md')).status, 200);
  assert.equal((await get('/notes/note.md')).status, 404);
  assert.equal((await get('/repos/notes/notes/note.md')).status, 404);
  assert.equal((await (await get('/')).url), `${ready.baseUrl}/notes/tree/`);

  for (const path of ['/markdown/', '/typst/', '/__control']) assert.equal((await get(path)).status, 404);
  const markdown = await (await get('/notes/api/document?path=note.md')).json();
  assert.match(markdown.html, /data-heading-key/);
  const typst = await (await get('/notes/api/document?path=note.typ')).json();
  assert.equal(typst.compile.status, 'success', JSON.stringify(typst.compile));
  assert.deepEqual(typst.outline.map(heading => heading.position.page), [1, 2]);
  assert.ok(typst.anchors.length >= 2);
  const svg = await (await get(typst.pages[0].url)).text();
  assert.match(svg, /data-typst-page="2"/);
  assert.doesNotMatch(svg, /foreignObject|class="tsel"/);
  const image = await (await get(`${typst.pages[0].url}&format=json`)).json();
  assert.equal(image.svg, svg);
  const internal = image.links.find(link => link.page === 2);
  assert.ok(internal);
  assert.ok(internal.width > 0 && internal.height > 0);
  assert.ok(internal.left >= 0 && internal.left + internal.width <= 100);
  assert.ok(internal.top >= 0 && internal.top + internal.height <= 100);
  assert.equal(image.links.find(link => link.href)?.href, 'https://example.com/?a=1&b=2');
  const secondImage = await (await get(`${typst.pages[1].url}&format=json`)).json();
  assert.doesNotMatch(secondImage.svg, /foreignObject/);
  const returnLink = secondImage.links.find(link => link.page === 1);
  assert.ok(returnLink);
  assert.ok(returnLink.top >= 0 && returnLink.top + returnLink.height <= 100, 'later-page links must subtract the page viewBox offset');


  const warning = await (await get('/notes/api/document?path=warning.typ')).json();
  assert.equal(warning.compile.status, 'success');
  assert.deepEqual(warning.compile.diagnostics, []);
  assert.match(output, /Typst warning:/);
  const opening = await fetch(`${ready.baseUrl}/api/library/open`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'notes', path: 'note.typ', line: 7, view: 'preview' }) });
  assert.deepEqual(await opening.json(), { reused: false, url: '/notes/tree/note.typ?line=7&view=preview' });
});
