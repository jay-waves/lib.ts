// Static chart markup is compiled by lib.comrak on the server. The browser
// only imports an interactive module and attaches handlers to that markup.
let d3ModuleUrl;
const hydrated = new WeakMap();
async function loadViz(source) {
  const [{ init, parse }, d3] = await Promise.all([import('es-module-lexer'), import('d3')]);
  await init;
  const [imports] = parse(source);
  if (!d3ModuleUrl) {
    globalThis.__libTsVizD3 = d3;
    const shim = Object.keys(d3).map(name => `export const ${name}=globalThis.__libTsVizD3.${name};`).join('\n');
    d3ModuleUrl = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
  }
  for (const entry of [...imports].reverse()) {
    if (entry.d !== -1 || entry.n !== 'd3') throw new Error('Only static imports from d3 are supported');
    source = source.slice(0, entry.s) + d3ModuleUrl + source.slice(entry.e);
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url); }
  finally { URL.revokeObjectURL(url); }
}

export function hydrateGraphs(root, modules) {
  let disposed = false;
  for (const [id, sourceUrl] of modules) {
    const chart = root.querySelector(`#${CSS.escape(id)}.viz`);
    if (!chart) continue;
    if (hydrated.get(chart) === sourceUrl) continue;
    void (async () => {
      try {
        const response = await fetch(sourceUrl);
        const module = await loadViz(await response.text());
        if (disposed) return;
        if (typeof module.hydrate !== 'function') throw new Error('viz hydrate must be a function');
        module.hydrate(chart);
        hydrated.set(chart, sourceUrl);
      } catch (error) {
        if (!disposed) console.error('Could not initialize chart interaction:', error);
      }
    })();
  }
  return () => { disposed = true; };
}
