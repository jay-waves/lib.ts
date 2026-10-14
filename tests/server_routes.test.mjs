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
  await writeFile(resolve(root, 'note.txt'), 'Plain text');
  await writeFile(resolve(root, 'theme.typ'), '#let theme = sys.inputs.at("theme")\n'
    + '#assert(theme in ("light", "dark"))\n'
    + '#set page(fill: if theme == "dark" { rgb("#212830") } else { white })\n'
    + 'Theme: #theme');
  await writeFile(resolve(root, 'note.typ'), '#set text(font: "Libertinus Serif")\n#set heading(numbering: "1.")\n= First <first>\n\nSee @second.\n\n#link("https://example.com/?a=1&b=2")[External link]\n#pagebreak()\n= Second <second>\n\nSee @first.\n\nEnd');
  await writeFile(resolve(root, 'warning.typ'), '#set text(font: "Libertinus Serif")\n#text(font: "UnavailableFont", "Fallback")');
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const server = spawn(process.execPath, [resolve('server-node.mjs'), root], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_PREVIEW_PORT: String(port), LIBRARY_DATA_DIRECTORY: resolve(temporary, 'data'),
      WASM_PREWARM: '0', TYPST_WASM_FONTS: '' },
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
  const rawMarkdown = await (await get('/notes/api/document?path=note.md&view=raw')).json();
  assert.equal(rawMarkdown.source, '# Before\n\nText');
  assert.equal(rawMarkdown.lineCount, 3);
  assert.equal(Object.hasOwn(rawMarkdown, 'html'), false);
  const markdown = await (await get('/notes/api/document?path=note.md')).json();
  assert.match(markdown.html, /data-heading-key/);
  const subscription = new AbortController();
  const events = await fetch(`${ready.baseUrl}/notes/api/library/events?path=note.md`, { signal: subscription.signal });
  const reader = events.body.getReader();
  let handshake = '';
  while (!handshake.includes('\n\n')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    handshake += new TextDecoder().decode(chunk.value);
  }
  assert.match(handshake, /event: connected/);
  assert.equal(JSON.parse(handshake.match(/data: (.*)/)[1]).modified, markdown.modified,
    'subscription reports the current revision so unchanged Markdown needs no reconnect refetch');
  subscription.abort();
  const text = await (await get('/notes/api/document?path=note.txt')).json();
  assert.equal(text.source, 'Plain text');
  assert.equal(text.text, undefined, 'document bodies are transmitted only once');
  const typst = await (await get('/notes/api/document?path=note.typ')).json();
  assert.equal(typst.compile.status, 'success', JSON.stringify(typst.compile));
  assert.deepEqual(typst.outline.map(heading => heading.position.page), [1, 2]);
  assert.ok(typst.anchors.length >= 2);
  const svg = await (await get(typst.pages[0].url)).text();
  const bounds = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert.deepEqual(bounds.slice(2), [typst.pages[0].width, typst.pages[0].height],
    'served SVG must use precise page bounds instead of rounded renderer dimensions');
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
  const light = await (await get('/notes/api/document?path=theme.typ')).json();
  const dark = await (await get('/notes/api/document?path=theme.typ&theme=dark')).json();
  assert.equal(light.compile.status, 'success');
  assert.equal(dark.compile.status, 'success');
  assert.notEqual(light.compile.id, dark.compile.id);
  const lightAgain = await (await get('/notes/api/document?path=theme.typ&theme=light')).json();
  assert.equal(lightAgain.compile.id, light.compile.id, 'light and dark use independent cached artifacts');
  assert.match(await (await get(dark.pages[0].url)).text(), /#212830/i);
  assert.equal((await get('/notes/api/document?path=theme.typ&theme=auto')).status, 400);
  const opening = await fetch(`${ready.baseUrl}/api/library/open`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'notes', path: 'note.typ', line: 7, view: 'preview' }) });
  assert.deepEqual(await opening.json(), { reused: false, url: '/notes/tree/note.typ?line=7&view=preview' });
});
