import { createByteCache, svgImageBytes } from '../../shared/byte-cache.mjs';
import { requestFlight } from '../../shared/request-flight.mjs';

// Bounded SVG response cache with in-flight request deduplication.
export function createSvgCache(limit = 16, request = globalThis.fetch, readResponse = response => response.text(), maxBytes = 4 * 1024 * 1024) {
  const cache = createByteCache({ maxEntries: limit, maxBytes, sizeOf: svgImageBytes });
  const pending = new Map();
  let generation = 0;
  async function pageSvg(url, { signal, prefetch = false } = {}) {
    signal?.throwIfAborted();
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const started = generation;
    const operation = requestFlight(pending, url, sharedSignal => request(url, { signal: sharedSignal, prefetch }).then(async response => {
      if (!response.ok) throw Object.assign(new Error(`SVG request failed (${response.status})`), { status: response.status });
      const svg = await readResponse(response);
      sharedSignal.throwIfAborted();
      if (started === generation) cache.set(url, svg);
      return svg;
    }), signal);
    return operation;
  }
  pageSvg.clear = () => {
    generation++;
    for (const { controller } of pending.values()) controller.abort();
    pending.clear();
    cache.clear();
  };
  return pageSvg;
}
