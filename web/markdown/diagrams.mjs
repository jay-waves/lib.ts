import { mountDiagram } from '../diagrams/mount.mjs';

// This adapter only translates Markdown's code blocks into diagram containers.
export function mountMarkdownDiagrams(root) {
  const cleanups = [];
  for (const code of root.querySelectorAll('.code-wrap pre > code.language-mermaid')) {
    const wrapper = code.closest('.code-wrap');
    const block = root.ownerDocument.createElement('div');
    block.className = 'diagram-view';
    block.setAttribute('aria-label', 'Mermaid diagram');
    const line = code.parentElement.getAttribute('data-source-line');
    if (line !== null) block.setAttribute('data-source-line', line);
    wrapper.replaceWith(block);
    const destroy = mountDiagram(block, code.textContent);
    cleanups.push(() => { destroy(); block.replaceWith(wrapper); });
  }
  return () => { for (const cleanup of cleanups) cleanup(); };
}
