import { resolve, relative, sep, isAbsolute } from 'node:path';
import { prepareTypstImage } from './image.mjs';
import { prepareInlineSvg, pageSvg, pageInfoFromArtifact } from './pages.mjs';
import { anchorTable } from './anchors.mjs';
import { compileTypstVector } from './compile.mjs';
import { analyzeTypst, anchorBlocks } from './tree.mjs';
import { createTypstRuntime } from './runtime.mjs';
import { typstInputs } from './inputs.mjs';
import { createArtifactStore } from './artifacts.mjs';

export function createTypstEngine({ root: serviceRoot, memorySample, profile, artifactMaxBytes, artifactLimit }) {
  const documents = createArtifactStore({ maxBytes: artifactMaxBytes, maxEntries: artifactLimit });
  function inside(base, path) {
    const rel = relative(base, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  }
  function libraryRelative(path) { return relative(serviceRoot, path).split(sep).join('/'); }
  const typstRuntime = createTypstRuntime({ memorySample });
  function logTypstDiagnostics(items, sourceFile) {
    for (const item of items) {
      const file = item.file || item.path || sourceFile;
      const location = item.range ? `:${typeof item.range === 'string' ? item.range : JSON.stringify(item.range)}` : '';
      console.log(`Typst ${item.severity || 'error'}: ${file}${location}: ${String(item.message).replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  function extractSvgPage(svg, page) {
    const tags = /<g\b[^>]*class="typst-page"[^>]*>/g;
    const first = tags.exec(svg);
    const root = svg.match(/^<svg\b[^>]*>/)?.[0];
    if (!root || !first) throw new Error('Typst renderer returned invalid page SVG');
    let match = first;
    for (let index = 1; index < page && match; index++) match = tags.exec(svg);
    if (!match) return;
    const start = match.index;
    let depth = 0, end = -1;
    for (const tag of svg.slice(start).matchAll(/<g\b[^>]*>|<\/g\s*>/g)) {
      depth += tag[0][1] === '/' ? -1 : 1;
      if (!depth) { end = start + tag.index + tag[0].length; break; }
    }
    if (end < 0) throw new Error(`Could not parse Typst SVG page ${page}`);
    const width = Number(match[0].match(/data-page-width="([\d.]+)/)?.[1]);
    const height = Number(match[0].match(/data-page-height="([\d.]+)/)?.[1]);
    const offset = match[0].match(/transform="translate\(([\d.-]+),\s*([\d.-]+)\)"/);
    const x = Number(offset?.[1] || 0), y = Number(offset?.[2] || 0);
    if (!(width > 0 && height > 0)) throw new Error(`Invalid Typst SVG page ${page} dimensions`);
    const pageRoot = root.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${width} ${height}"`)
      .replace(/\b(width|height|data-width|data-height)="[^"]*"/g, (_attr, name) => `${name}="${name.endsWith('width') ? width : height}"`);
    return { svg: `${svg.slice(0, first.index).replace(root, pageRoot)}${svg.slice(start, end)}</svg>`, width, height };
  }
  function libraryDiagnostics(items, sourceFile) {
    return (items || []).map(item => {
      const rawPath = item.path || item.file;
      const resolved = typeof rawPath === 'string' && !item.package ? resolve(rawPath) : undefined;
      const file = resolved && inside(serviceRoot, resolved) ? libraryRelative(resolved)
        : typeof rawPath === 'string' ? rawPath : libraryRelative(sourceFile);
      let range = null;
      if (typeof item.range === 'string') {
        const match = item.range.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
        if (match) range = { start: { line: Number(match[1]), column: Number(match[2]) },
          end: { line: Number(match[3]), column: Number(match[4]) } };
      } else if (item.range?.start && item.range?.end) {
        range = { start: item.range.start, end: item.range.end };
      }
      return { file, severity: ['error', 'warning', 'info', 'hint'].includes(item.severity) ? item.severity : 'error',
        message: String(item.message || 'Typst compilation failed'), range };
    });
  }
  async function compile({ id, file, source, theme }) {
    const parsed = await analyzeTypst(source);
    const marked = anchorBlocks(source, parsed.blocks, { headings: parsed.headings, minLineGap: 24 });
    let clock = performance.now();
    const runtime = await typstRuntime.init(file);
    profile('library native/renderer wait', clock); clock = performance.now();
    const result = compileTypstVector(runtime.compiler, file, marked.text,
      { queryAnchors: true, verifyRestoration: true, inputs: typstInputs(theme) });
    profile('library compile/vector', clock); clock = performance.now();
    const diagnostics = libraryDiagnostics(result.diagnostics, file);
    logTypstDiagnostics(diagnostics, file);
    const pages = result.artifact
      ? (await pageInfoFromArtifact(runtime.renderer, result.artifact)).map(({ width, height }) => ({ width, height })) : [];
    profile('library page info', clock);
    const anchors = anchorTable(result.anchors || [], marked.positions, pages);
    const headingAnchors = new Map(anchors.map(anchor => [anchor.line, anchor]));
    const outline = parsed.headings.map(heading => {
      const anchor = headingAnchors.get(heading.line);
      return { ...heading, position: anchor ? { page: anchor.page,
        y: anchor.y / pages[anchor.page - 1].height } : null };
    });
    const artifactBytes = result.artifact?.buffer?.byteLength ?? result.artifact?.byteLength ?? 0;
    documents.set(id, { artifact: result.artifact, info: pages, artifactBytes });
    return { info: pages, diagnostics, anchors, outline, artifactBytes, fingerprint: result.fingerprint };
  }
  async function page({ id, page }) {
    const item = documents.get(id);
    if (!item) throw Object.assign(new Error('Typst artifact is not resident'), { code: 'ARTIFACT_MISSING' });
    const clock = performance.now();
    const full = await pageSvg(typstRuntime.value, item.artifact, item.info, page - 1);
    const text = extractSvgPage(full, page)?.svg;
    if (!text) throw new Error('Page SVG unavailable');
    const image = prepareTypstImage(prepareInlineSvg(text, `library-${id}-${page}`), item.info[page - 1]);
    profile(`library svg page ${page}`, clock);
    return image;
  }
  return { compile, page, discard: id => documents.delete(id), retain: ids => documents.retain(ids) };
}
