import { createHash } from 'node:crypto';
import { createByteCache } from '../../shared/byte-cache.mjs';
import { createWorkerRuntime } from '../worker-runtime.mjs';
import { requestFlight } from '../../shared/request-flight.mjs';
import { createWorkerClient } from '../worker-client.mjs';

export function createMarkdownService({ workerIdleMs = 60_000, emit, profile } = {}) {
  const cache = createByteCache({ maxEntries: 64, maxBytes: 8 * 1024 * 1024,
    sizeOf: html => html.length * 2, ttl: 5 * 60_000 });
  const pending = new Map();
  const worker = createWorkerClient({ name: 'Markdown', url: new URL('./worker.mjs', import.meta.url), emit, profile });
  const runtime = createWorkerRuntime({ worker, name: 'Markdown', workerIdleMs });

  function render(source, { allowRawHtml = true, documentKey, signal } = {}) {
    if (runtime.closed) return Promise.reject(new Error('Markdown service is closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    source = String(source);
    allowRawHtml = Boolean(allowRawHtml);
    const key = `${allowRawHtml ? 'html' : 'safe'}:${createHash('sha256').update(source).digest('hex')}`;
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const taskKey = documentKey ? `${documentKey}:${allowRawHtml}` : undefined;
    const flightKey = `${taskKey || ''}:${key}`;
    return requestFlight(pending, flightKey, sharedSignal => runtime.run(async ({ assertCurrent }) => {
      const html = await worker.request('render', { source, options: { allowRawHtml } });
      assertCurrent();
      if (!runtime.closed) cache.set(key, html);
      return html;
    }, { key: taskKey, signal: sharedSignal, bytes: source.length * 2 }), signal);
  }

  async function close() {
    await runtime.close();
    cache.clear();
  }
  return { render, close };
}
