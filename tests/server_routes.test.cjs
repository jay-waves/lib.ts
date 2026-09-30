const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { writeFile, unlink } = require('node:fs/promises');

test('unified Node service exposes library and preview routes', async () => {
  const watchedFile = resolve(`tests/fixtures/watch-${process.pid}.md`);
  await writeFile(watchedFile, '# Before\n');
  const server = spawn('node', [resolve('server-node.mjs'), '--', resolve('.')], {
    cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { errors += chunk; });

  try {
    const ready = await new Promise((done, fail) => {
      const timeout = setTimeout(() => fail(new Error(`service did not start: ${errors}`)), 10000);
      server.once('error', fail);
      server.once('exit', code => fail(new Error(`service exited ${code}: ${errors}`)));
      const check = () => {
        const line = output.split('\n').find(part => part.includes('"event":"ready"'));
        if (!line) return;
        clearTimeout(timeout);
        done(JSON.parse(line));
      };
      server.stdout.on('data', check);
      check();
    });

    for (const path of ['/api/tree', '/markdown/', '/typst/']) {
      const response = await fetch(`${ready.baseUrl}${path}`);
      assert.equal(response.status, 200, path);
    }

    const document = await fetch(`${ready.baseUrl}/api/document?path=${encodeURIComponent('README.md')}`);
    assert.equal(document.status, 200);
    assert.equal((await document.json()).type, 'markdown');

    const libraryEvents = await fetch(`${ready.baseUrl}/api/library/events?path=README.md&asset=LICENSE`);
    assert.equal(libraryEvents.status, 200);
    const libraryReader = libraryEvents.body.getReader();
    assert.match(new TextDecoder().decode((await libraryReader.read()).value), /event: connected/);
    await libraryReader.cancel();

    const warningDocument = await fetch(`${ready.baseUrl}/api/document?path=tests/fixtures/typst-warning.typ`);
    assert.equal(warningDocument.status, 200);
    const warningState = await warningDocument.json();
    assert.equal(warningState.compile.status, 'success');
    assert.deepEqual(warningState.compile.diagnostics, []);
    assert.match(output, /Typst warning:.*unknown font family/i);
    const libraryPage = await fetch(`${ready.baseUrl}${warningState.pages[0].url}`);
    assert.equal(libraryPage.status, 200);
    assert.match(await libraryPage.text(), /class="typst-page"/);
    assert.equal((await fetch(`${ready.baseUrl}/api/typst/page?id=expired&page=1`)).status, 410);

    const errorDocument = await fetch(`${ready.baseUrl}/api/document?path=tests/fixtures/typst-error.typ`);
    assert.equal(errorDocument.status, 200);
    const errorState = await errorDocument.json();
    assert.equal(errorState.compile.status, 'failed');
    assert.ok(errorState.compile.diagnostics.length > 0);
    assert.ok(errorState.compile.diagnostics.every(item => item.severity === 'error'));
    assert.match(output, /Typst error:/);

    server.stdin.write(JSON.stringify({ kind: 'typst', method: 'warm',
      file: resolve('tests/fixtures/typst-warning.typ'),
      text: '#set text(font: ("Missing Preview Font", "Arial"))\nWarning-only document.',
      revision: 1 }) + '\n');
    const warningPreview = await waitForTypstState(ready.baseUrl, 'typst-warning.typ');
    assert.ok(warningPreview.count > 0);
    assert.deepEqual(warningPreview.diagnostics, []);

    server.stdin.write(JSON.stringify({ kind: 'typst', method: 'warm',
      file: resolve('tests/fixtures/typst-error.typ'), text: '#import "missing.typ": missing',
      revision: 2 }) + '\n');
    const errorPreview = await waitForTypstState(ready.baseUrl, 'typst-error.typ');
    assert.ok(errorPreview.diagnostics.length > 0);
    assert.ok(errorPreview.diagnostics.every(item => item.severity === 'error'));

    server.stdin.write(JSON.stringify({ kind: 'typst', method: 'warm',
      file: resolve('tests/fixtures/typst-warning.typ'),
      text: 'First page.\n#pagebreak()\nSecond page.', revision: 3 }) + '\n');
    const twoPagePreview = await waitForTypstState(ready.baseUrl, 'typst-warning.typ');
    assert.equal(twoPagePreview.count, 2);
    const secondPage = await fetch(`${ready.baseUrl}/typst/__live/asset?p=${encodeURIComponent(twoPagePreview.files[1])}`);
    assert.equal(secondPage.status, 200);
    const secondSvg = await secondPage.text();
    assert.match(secondSvg, /class="typst-page"/);
    assert.match(secondSvg, /Second page/);
    assert.doesNotMatch(secondSvg, /First page/);

    const stream = await fetch(`${ready.baseUrl}/markdown/__live/events`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /data: connected/);
    await reader.cancel();

    const control = await fetch(`${ready.baseUrl}/__control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'open', kind: 'markdown',
        file: watchedFile, cwd: resolve('.') }),
    });
    assert.equal(control.status, 200, await control.text());
    assert.match((await (await fetch(`${ready.baseUrl}/markdown/document`)).json()).html, /Before/);
    await writeFile(watchedFile, '# After\n');
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await (await fetch(`${ready.baseUrl}/markdown/document`)).json();
      if (state.html.includes('After')) break;
      if (attempt === 99) throw new Error('Markdown file watcher did not refresh the preview');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    if (server.exitCode === null) {
      server.stdin.write('{"method":"shutdown"}\n');
      await Promise.race([
        new Promise(done => server.once('exit', done)),
        new Promise(done => setTimeout(done, 1000)),
      ]);
      if (server.exitCode === null) server.kill();
    }
    await unlink(watchedFile);
  }
});

async function waitForTypstState(baseUrl, filename) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await (await fetch(`${baseUrl}/typst/state`)).json();
    if (state.document.endsWith(filename) && (state.count || state.diagnostics.length)) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Typst state did not complete for ${filename}`);
}
