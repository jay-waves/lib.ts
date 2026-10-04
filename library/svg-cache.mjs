import { createByteCache, svgImageBytes } from './byte-cache.mjs';

// Bounded SVG response cache with in-flight request deduplication.
export function createSvgCache(limit = 16, request = globalThis.fetch, readResponse = response => response.text(), maxBytes = 4 * 1024 * 1024) {
  const cache = createByteCache({ maxEntries: limit, maxBytes, sizeOf: svgImageBytes });
  const pending = new Map();
  let generation = 0;
  async function pageSvg(url) {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    if (pending.has(url)) return pending.get(url).operation;
    const started = generation;
    const controller = new AbortController();
    const operation = request(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Object.assign(new Error(`SVG request failed (${response.status})`), { status: response.status });
      const svg = await readResponse(response);
      if (started === generation) cache.set(url, svg);
      return svg;
    });
    pending.set(url, { operation, controller });
    try { return await operation; } finally { if (pending.get(url)?.operation === operation) pending.delete(url); }
  }
  pageSvg.clear = () => {
    generation++;
    for (const { controller } of pending.values()) controller.abort();
    pending.clear();
    cache.clear();
  };
  return pageSvg;
}
