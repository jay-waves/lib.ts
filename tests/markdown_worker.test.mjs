import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createMarkdownService } from '../server/markdown/service.mjs';

test('Markdown worker deduplicates, preserves option-specific cache after idle and restarts', async t => {
  const stages = [];
  const service = createMarkdownService({ workerIdleMs: 25, profile: stage => stages.push(stage) });
  t.after(() => service.close());
  assert.deepEqual(stages, []);
  const source = '# Heading\n\n<script>test</script>\n\n$x^2$';
  const one = service.render(source), two = service.render(source);
  assert.strictEqual(one, two);
  const html = await one;
  assert.match(html, /class="katex"/);
  assert.match(html, /<script>/);
  assert.equal(stages.filter(stage => stage === 'markdown render').length, 1);
  for (let attempt = 0; attempt < 100 && !stages.includes('Markdown worker stop'); attempt++) await delay(10);
  assert.ok(stages.includes('Markdown worker stop'));
  assert.equal(await service.render(source), html);
  assert.equal(stages.filter(stage => stage === 'Markdown worker start').length, 1);
  assert.doesNotMatch(await service.render(source, { allowRawHtml: false }), /<script>/);
  assert.equal(stages.filter(stage => stage === 'Markdown worker start').length, 2);
  await service.close();
  await assert.rejects(service.render(source), /closed/);
});

test('closing Markdown service rejects running and queued work', async () => {
  const service = createMarkdownService();
  const results = Promise.allSettled([service.render('# First'), service.render('# Second')]);
  await service.close();
  for (const result of await results) assert.equal(result.status, 'rejected');
});
