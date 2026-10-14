import { loadRawHighlighter } from '../raw-highlight-loader.mjs';
import { renderMath } from '../katex-loader.mjs';

const mathSelector = '[data-math-style="inline"], [data-math-style="display"]';
const codeSelector = '.code-wrap pre > code[class*="language-"]';

export async function enhanceMarkdown(root) {
  if (!root) return;

  const mathNodes = [...root.querySelectorAll(mathSelector)]
    .filter(node => !node.querySelector(mathSelector));
  const codeNodes = [...root.querySelectorAll(codeSelector)]
    .filter(node => !node.hasAttribute('data-math-style'));
  const pending = [];

  for (const node of mathNodes) {
    const source = node.dataset.libraryMathSource ?? node.textContent;
    if (node.dataset.libraryMathSource === source && node.dataset.libraryMathRendered) continue;
    node.dataset.libraryMathSource = source;
    node.dataset.libraryMathRendered = 'pending';
    const displayMode = node.dataset.mathStyle === 'display';
    pending.push(renderMath(source, displayMode).then(html => {
      if (displayMode && node.tagName === 'CODE' && node.parentElement?.tagName === 'PRE') {
        const block = node.ownerDocument.createElement('div');
        block.className = 'math-block';
        const line = node.parentElement.getAttribute('data-source-line');
        if (line !== null) block.setAttribute('data-source-line', line);
        block.innerHTML = html;
        node.parentElement.replaceWith(block);
      } else node.innerHTML = html;
      node.dataset.libraryMathRendered = 'true';
    }).catch(() => {
      node.textContent = source;
      node.dataset.libraryMathRendered = 'error';
    }));
  }

  const needsHighlight = codeNodes.some(node =>
    node.dataset.libraryHighlightSource !== node.textContent);
  if (needsHighlight) {
    pending.push(loadRawHighlighter().then(({ highlightElement }) => {
      for (const node of codeNodes) {
        const source = node.textContent;
        if (node.dataset.libraryHighlightSource === source) continue;
        node.textContent = source;
        node.dataset.libraryHighlightSource = source;
        highlightElement(node);
      }
    }));
  }

  await Promise.all(pending);
}
