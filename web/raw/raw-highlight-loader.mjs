let highlighter;
export function loadRawHighlighter() {
  return highlighter ??= import('./raw-highlight.mjs');
}
