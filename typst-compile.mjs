// Library and editor preview share one compile/query/vector snapshot.
export async function compileTypstVector(compiler, mainFilePath, source,
  { queryAnchors = false, loadMissingPackage } = {}) {
  const compile = async text => {
    compiler.addSource(mainFilePath, text);
    return compiler.runWithWorld({ mainFilePath }, async world => {
      const compiled = await world.compile({ diagnostics: 'full' });
      const diagnostics = compiled.diagnostics || [];
      if (compiled.hasError) return { artifact: undefined, diagnostics, anchors: [] };
      const anchors = queryAnchors ? await world.query({ selector: 'metadata' }) : [];
      const vector = await world.vector({ diagnostics: 'full' });
      return { artifact: vector.result, diagnostics, anchors };
    });
  };

  let result = await compile(source);
  if (loadMissingPackage) {
    const attempted = new Set();
    for (let count = 0; count < 12 && !result.artifact; count++) {
      const missing = result.diagnostics.map(item =>
        String(item.message || '').match(/package not found \(searched for @preview\/([a-z0-9-]+):(\d+\.\d+\.\d+)\)/i))
        .find(Boolean);
      if (!missing) break;
      const spec = `${missing[1]}:${missing[2]}`;
      if (attempted.has(spec) || !await loadMissingPackage(missing[1], missing[2])) break;
      attempted.add(spec);
      result = await compile(source);
    }
  }
  let mathFontFallback = false;
  if (!result.artifact && source.includes('$') && result.diagnostics.some(item =>
    item.severity === 'error' && item.message.includes('no font could be found'))) {
    result = await compile(`#show math.equation: set text(font: "Cambria Math")\n${source}`);
    mathFontFallback = Boolean(result.artifact);
  }
  return { ...result, mathFontFallback };
}
