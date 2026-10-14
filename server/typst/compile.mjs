import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Query and export the same native document, then age unused comemo results.
export function compileTypstVector(compiler, file, source, { queryAnchors = false, verifyRestoration = false, inputs = {} } = {}) {
  const mainFilePath = resolve(file);
  let compiled, document;
  try {
    compiler.addSource(mainFilePath, source);
    compiled = compiler.compile({ mainFilePath, inputs, resetRead: true });
    const diagnostics = [compiled.takeError(), compiled.takeWarnings()].filter(Boolean)
      .flatMap(item => compiler.fetchDiagnostics(item)).map(item => ({ ...item,
        severity: ({ 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' })[item.severity] || item.severity,
        range: item.range?.start && item.range?.end ? {
          start: { line: item.range.start.line + 1, column: item.range.start.character + 1 },
          end: { line: item.range.end.line + 1, column: item.range.end.character + 1 },
        } : null,
      }));
    document = compiled.result;
    if (!document) return { artifact: undefined, diagnostics, anchors: [] };
    const anchors = queryAnchors ? compiler.query(document, { selector: 'metadata' }) : [];
    // Vector serialization contains process-specific data. Canonical native SVG
    // gives a stable content identity across worker restarts, including imports/images.
    const fingerprint = verifyRestoration
      ? createHash('sha256').update(compiler.plainSvg(document)).digest('hex') : undefined;
    return { artifact: compiler.vector(document), diagnostics, anchors, fingerprint };
  } finally {
    document = undefined;
    compiled = undefined;
    try { compiler.unmapShadow(mainFilePath); }
    finally { compiler.evictCache(30); }
  }
}
