import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverTypstFonts, bundledFontsDirectory } from '../server/typst/fonts.mjs';
import { createTypstRuntime, packageRoot } from '../server/typst/runtime.mjs';
import { compileTypstVector } from '../server/typst/compile.mjs';

test('only application fonts are loaded independently of package and Windows directories', () => {
  const expected = JSON.parse(readFileSync(resolve(bundledFontsDirectory, 'manifest.json')))
    .map(name => resolve(bundledFontsDirectory, name));
  assert.deepEqual(discoverTypstFonts({ WINDIR: 'missing', LOCALAPPDATA: 'missing' }), expected);
  assert.equal(expected.filter(file => /Georgia[\\/].*\.ttf$/i.test(file)).length, 4);
  assert.deepEqual(discoverTypstFonts({ TYPST_WASM_FONTS: `${expected[0]};${expected[0]};missing.ttf` }), [expected[0]]);
});

test('offline bundled default, CJK and code fonts compile without template packages', async () => {
  const runtime = createTypstRuntime();
  const { compiler } = await runtime.init();
  const source = `Default serif, *bold*, _italic_. \`default mono\`

#set text(font: ("Georgia", "Source Han Serif"))
正文 Latin, *bold*, _italic_, *_bold italic_*

#text(font: "Source Han Sans")[标题 Heading]

#text(font: "Source Han Serif SC")[宋体 *粗体*]
#text(font: "Source Han Sans SC")[黑体 *粗体*]

#show raw: set text(font: "Iosevka")
\`code\`

$ cal(R) quad bb(R) quad frak(R) quad integral_0^1 x^2 dif x $`;
  const result = await compileTypstVector(compiler, '/bundled-fonts.typ', source);
  assert.ok(result.artifact, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
});

test('installed template uses bundled Georgia for body text', async t => {
  if (!existsSync(resolve(packageRoot('local'), 'ypst-template/0.1.0/lib.typ'))) {
    t.skip('Local template is not installed');
    return;
  }
  const runtime = createTypstRuntime();
  const { compiler } = await runtime.init();
  const result = await compileTypstVector(compiler, '/georgia-template.typ',
    '#import "@local/ypst-template:0.1.0": template\n#show: template\n'
    + '= 标题 Heading\n正文 Georgia *Bold* _Italic_ *_Bold Italic_*\n\n`code`\n\n$ cal(R) $');
  assert.ok(result.artifact, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics.filter(item => item.severity === 'error'
    || /unknown font family: georgia|not designed for math/i.test(item.message)), []);
});
