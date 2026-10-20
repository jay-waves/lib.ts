import test from 'node:test';
import assert from 'node:assert/strict';
import { documentSchema, documentInfoSchema } from '../web/api/documents.ts';
import { readerView, readerViews } from '../web/reader-session.mjs';
import { detectType, load, render } from 'pele/lazy';

test('standalone Mermaid documents retain source and offer Preview and Raw', () => {
  const identity = { path: '图表.MMD', absolutePath: '/notes/图表.MMD', name: '图表.MMD', size: 24, modified: 'v1' };
  const document = documentSchema.parse({ ...identity, type: 'mermaid', source: 'flowchart LR\n A --> B', lineCount: 2 });
  assert.equal(document.type, 'mermaid');
  assert.equal(documentInfoSchema.parse({ ...identity, type: 'mermaid', mime: 'application/octet-stream', format: 'mmd', media: null, playable: false }).type, 'mermaid');
  assert.deepEqual(readerViews(document), ['preview', 'raw']);
  assert.equal(readerView(document), 'preview');
  assert.equal(readerView(document, 'raw'), 'raw');
});

test('lazy renderer accepts Chinese labels and generates themeable SVG for common types', async () => {
  for (const source of [
    'flowchart LR\n A[开始] --> B[结束]',
    'sequenceDiagram\n Alice->>Bob: 你好',
    'classDiagram\n Animal <|-- Duck',
  ]) {
    await load(detectType(source));
    const result = render(source, { autoDirection: false });
    assert.match(result.svg, /<svg/);
    assert.match(result.svg, /var\(--pele-/);
    assert.ok(result.width > 0 && result.height > 0);
  }
  assert.throws(() => render('not a diagram'), /./);
});
