// Render each requested page in a fresh session: SVG diffs otherwise depend on
// the order of previous window requests and cannot be served as image assets.
export function releaseSession(session) {
  session?.[Symbol.for('reflexo-obj')]?.free();
}

export async function pageInfoFromArtifact(renderer, artifact) {
  const session = await renderer.createModule(artifact);
  try { return session.retrievePagesInfo(); }
  finally { releaseSession(session); }
}

export function prepareInlineSvg(svg, prefix) {
  const ids = new Map([...svg.matchAll(/\bid="([^"]+)"/g)]
    .map(match => [match[1], `${prefix}-${match[1]}`]));
  // Scan a fixed number of times, independent of the number of glyph IDs.
  svg = svg.replace(/\bid="([^"]+)"/g, (match, id) => ids.has(id) ? `id="${ids.get(id)}"` : match)
    .replace(/((?:xlink:)?href=")#([^"]+)"/g,
      (match, attr, id) => ids.has(id) ? `${attr}#${ids.get(id)}"` : match)
    .replace(/url\(#([^)]+)\)/g, (match, id) => ids.has(id) ? `url(#${ids.get(id)})` : match);
  return svg.replace(/<a\b([^>]*?)\s+onclick="handleTypstLocation\(this,\s*(\d+),\s*([\d.]+),\s*([\d.]+)\);?\s*return false"([^>]*)>/g,
    (_tag, before, page, x, y, after) => `<a${before} data-typst-page="${page}" data-typst-x="${x}" data-typst-y="${y}"${after}>`)
    .replace(/<rect\b([^>]*class="pseudo-link"[^>]*)>/g, '<rect fill="transparent"$1>');
}

export async function pageSvg(runtime, artifact, infos, index) {
  const session = await runtime.renderer.createModule(artifact);
  try {
    const info = infos[index];
    const y = infos.slice(0, index).reduce((sum, page) => sum + page.height, 0);
    return session.renderSvgDiff({ window: {
      lo: { x: -1, y: y + 0.01 }, hi: { x: info.width + 1, y: y + info.height - 0.01 },
    } });
  } finally {
    releaseSession(session);
  }
}
