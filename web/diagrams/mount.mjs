import DOMPurify from 'dompurify';
import './diagram.css';

// No Markdown or reader dependencies: both callers own the returned cleanup.
export function mountDiagram(container, source) {
  let disposed = false, diagram;
  container.removeAttribute('role');
  container.textContent = 'Loading diagram…';
  container.setAttribute('aria-busy', 'true');
  void (async () => {
    try {
      const { detectType, load, mount } = await import('pele/lazy');
      if (disposed) return;
      const type = detectType(source);
      if (type) await load(type);
      if (disposed) return;
      container.textContent = '';
      diagram = mount(container, source, {
        autoDirection: false,
        onError: () => container.setAttribute('role', 'alert'),
        onRender: () => container.removeAttribute('role'),
        sanitize: svg => DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true,
        }),
      });
    } catch (error) {
      if (!disposed) {
        container.textContent = `Could not render diagram: ${error.message || error}\n\n${source}`;
        container.setAttribute('role', 'alert');
      }
    } finally {
      if (!disposed) container.removeAttribute('aria-busy');
    }
  })();
  return () => { disposed = true; diagram?.destroy(); };
}
