let katex;

export function loadKatex() {
  return katex ??= import('katex');
}

export async function renderMath(source, displayMode) {
  const { default: engine } = await loadKatex();
  return engine.renderToString(source.replace(/\u200b/g, ''), {
    displayMode,
    throwOnError: false,
  });
}
