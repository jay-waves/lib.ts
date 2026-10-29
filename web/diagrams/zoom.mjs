// Attach navigation to the already compiled SVG without re-rendering it.
export function enableDiagramZoom(container) {
  let disposed = false, selection;
  const svg = container.querySelector('svg');
  if (!svg) return () => {};
  void import('d3').then(d3 => {
    if (disposed) return;
    selection = d3.select(container);
    selection.call(d3.zoom().scaleExtent([0.5, 5]).on('zoom', event => {
      svg.style.transformOrigin = '0 0';
      svg.style.transform = `translate(${event.transform.x}px, ${event.transform.y}px) scale(${event.transform.k})`;
    }));
  }).catch(error => console.error('Could not initialize diagram navigation:', error));
  return () => { disposed = true; selection?.on('.zoom', null); };
}
