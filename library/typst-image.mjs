// The renderer emits SVG link rectangles inside transformed groups. Resolve
// those coordinates once, before sending a lightweight image and link overlay.
const identity = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
    a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
    a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function transform(value = '') {
  let result = identity;
  for (const [, name, args] of value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const n = args.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    let matrix;
    if (name === 'matrix') matrix = n;
    else if (name === 'translate') matrix = [1, 0, 0, 1, n[0], n[1] || 0];
    else if (name === 'scale') matrix = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
    else {
      const angle = n[0] * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
      if (name === 'rotate') {
        matrix = [c, s, -s, c, 0, 0];
        if (n.length === 3) matrix = multiply(multiply([1,0,0,1,n[1],n[2]], matrix), [1,0,0,1,-n[1],-n[2]]);
      } else matrix = name === 'skewX' ? [1,0,Math.tan(angle),1,0,0] : [1,Math.tan(angle),0,1,0,0];
    }
    if (matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new Error('Invalid SVG link transform');
    result = multiply(result, matrix);
  }
  return result;
}
function decode(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === 'x' ? 2 : 1), entity[1].toLowerCase() === 'x' ? 16 : 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
  });
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(([, name, double, single]) => [name, decode(double ?? single)]));
}

export function prepareTypstImage(source) {
  // No selectable HTML text is needed in image mode.
  const svg = source.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/g, '');
  const root = attributes(svg.match(/<svg\b[^>]*>/)?.[0] || '');
  const box = root.viewBox?.trim().split(/[\s,]+/).map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0)
    throw new Error('Invalid Typst image viewBox');
  const links = [], stack = [{ matrix: identity, link: null }];
  for (const [tag] of svg.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    if (tag.startsWith('</')) { stack.pop(); continue; }
    const name = tag.match(/^<([\w:-]+)/)[1], attrs = attributes(tag);
    const parent = stack.at(-1);
    const matrix = attrs.transform ? multiply(parent.matrix, transform(attrs.transform)) : parent.matrix;
    const link = name === 'a' ? attrs : parent.link;
    if (name === 'rect' && link && (attrs.class || '').split(/\s+/).includes('pseudo-link')) {
      const x = Number(attrs.x || 0), y = Number(attrs.y || 0), width = Number(attrs.width), height = Number(attrs.height);
      if (width > 0 && height > 0 && [x,y,width,height].every(Number.isFinite)) {
        const points = [[x,y],[x+width,y],[x,y+height],[x+width,y+height]].map(([px,py]) =>
          [matrix[0]*px+matrix[2]*py+matrix[4], matrix[1]*px+matrix[3]*py+matrix[5]]);
        const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
        const left = Math.min(...xs), top = Math.min(...ys);
        const region = { left: (left-box[0])/box[2]*100, top: (top-box[1])/box[3]*100,
          width: (Math.max(...xs)-left)/box[2]*100, height: (Math.max(...ys)-top)/box[3]*100 };
        const page = Number(link['data-typst-page']);
        if (page > 0 && Number.isInteger(page) && [Number(link['data-typst-x']), Number(link['data-typst-y'])].every(Number.isFinite)) {
          links.push({ ...region, page, x: Number(link['data-typst-x']), y: Number(link['data-typst-y']) });
        } else {
          const href = (link.href || link['xlink:href'] || '').trim();
          const scheme = href.replace(/[\u0000-\u0020]/g, '').match(/^([\w+.-]+):/)?.[1]?.toLowerCase();
          if (href && (!scheme || ['http', 'https', 'mailto', 'tel', 'ftp'].includes(scheme)))
            links.push({ ...region, href, target: link.target === '_blank' ? '_blank' : undefined });
        }
      }
    }
    if (!tag.endsWith('/>')) stack.push({ matrix, link });
  }
  return { svg, links };
}
