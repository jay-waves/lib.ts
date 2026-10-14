import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'parse5';
import { htmlPreviewResponse } from '../server/html-preview.mjs';
import { createLibraryRoutes } from '../server/routes.mjs';

test('HTML keeps interactive scripts while removing alternate bases and embedded documents', async () => {
  const response = htmlPreviewResponse('<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">'
    + '<style>body{color:red}</style><button onclick="this.textContent=42">Run</button>'
    + '<script>document.title="Ready"</script><a href="#section">Jump</a><iframe src="https://evil.example/"></iframe>',
  '笔记/report.html', '/notes/api', 'http://localhost/notes/api/html', 'test-token');
  const html = await response.text();
  assert.match(html, /onclick="this.textContent=42"/);
  assert.match(html, /<script>document.title="Ready"<\/script>/);
  assert.doesNotMatch(html, /evil\.example|http-equiv|<iframe/);
  assert.match(html, /href="http:\/\/localhost\/notes\/api\/html\?path=.*#section"/);
  assert.match(html, /<base href="http:\/\/localhost\/notes\/api\/html-resource\/test-token\/%E7%AC%94%E8%AE%B0\/">/);
  const csp = response.headers.get('content-security-policy');
  for (const rule of ["sandbox allow-scripts", "connect-src 'none'", "form-action 'none'", "worker-src 'none'", "frame-src 'none'"])
    assert.ok(csp.includes(rule), rule);
  assert.doesNotMatch(csp, /allow-same-origin|unsafe-eval|https:/);
});

test('HTML routes identify documents, serve typed local resources, and reject private paths', async t => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'html-preview-'));
  const root = resolve(temporary, 'notes');
  await mkdir(resolve(root, 'assets'), { recursive: true });
  await writeFile(resolve(temporary, 'outside.js'), 'throw new Error("private")');
  await writeFile(resolve(root, 'report.HTM'), '<h1>Report</h1><script src="assets/chart.js"></script>');
  await writeFile(resolve(root, 'assets/chart.js'), 'document.title="Chart"');
  await writeFile(resolve(root, 'secret.json'), '{"secret":true}');
  await writeFile(resolve(root, 'index.html'), '<div id="root"></div>');
  const canonical = await realpath(root);
  const app = createLibraryRoutes({ root: canonical, dist: canonical, apiBase: '/notes/api',
    checkedPath(value) {
      const file = realpathSync(resolve(canonical, value));
      const path = relative(canonical, file);
      if (path.startsWith('..') || isAbsolute(path)) throw new Error('Outside repository');
      return file;
    }, json: (value, status = 200) => Response.json(value, { status }),
    search: Object.assign(() => {}, { close() {} }),
  });
  t.after(async () => { app.close(); await rm(temporary, { recursive: true, force: true }); });
  const document = await (await app.request('/api/document?path=report.HTM')).json();
  assert.equal(document.type, 'html');
  assert.ok(document.source.includes('<script'));
  assert.equal(document.url, '/notes/api/html?path=report.HTM');
  const preview = await app.request('/api/html?path=report.HTM');
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts/);
  const shell = await app.request('/');
  assert.match(shell.headers.get('content-security-policy'), /frame-src http:\/\/localhost\/notes\/api\/html;/);
  const token = (await preview.text()).match(/html-resource\/([a-f0-9]+)\//)[1];
  const resources = `/api/html-resource/${token}/`;
  const script = await app.request(resources + 'assets/chart.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');
  assert.equal(script.headers.get('access-control-allow-origin'), '*');
  assert.equal((await app.request(resources + 'secret.json')).status, 403);
  assert.equal((await app.request(resources + 'index.html')).status, 403);
  assert.equal((await app.request(resources + '%2e%2e%2foutside.js')).status, 400);
  assert.equal((await app.request('/api/html-resource/wrong/assets/chart.js')).status, 403);
  assert.equal((await app.request('/api/html?path=assets/chart.js')).status, 400);
  assert.equal((await app.request('/api/asset?path=report.HTM')).headers.get('content-type'), 'text/plain; charset=utf-8');
});


test('web links open outside the preview while fragments and local assets stay inside', async () => {
  const response = htmlPreviewResponse(
    '<a href="https://example.org/page" target="_top" rel="opener external">Web</a>'
    + '<a href="//example.org/other">Protocol relative</a>'
    + '<a href="#note">Note</a><a href="images/chart.svg">Local</a>'
    + '<a href="mailto:test@example.org">Mail</a>',
    'notes/report.html', '/api', 'http://localhost/api/html', 'token');
  const anchors = [];
  function visit(node) {
    if (node.tagName === 'a') anchors.push(Object.fromEntries(node.attrs.map(a => [a.name, a.value])));
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(await response.text()));
  for (const anchor of anchors.slice(0, 2)) {
    assert.equal(anchor.target, '_blank');
    assert.ok(anchor.rel.includes('noopener'));
    assert.ok(anchor.rel.includes('noreferrer'));
    assert.ok(!anchor.rel.split(/\s+/).includes('opener'));
  }
  for (const anchor of anchors.slice(2)) assert.equal(anchor.target, undefined);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/);
});
