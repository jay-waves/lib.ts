import { parse, parseFragment, serialize } from 'parse5';
import { readFileSync } from 'node:fs';

const imageTheme = readFileSync(new URL('../shared/image-theme.css', import.meta.url), 'utf8');

// The browser executes document scripts only inside an opaque sandbox origin.
export function htmlPreviewResponse(source, path, apiBase, requestUrl, resourceToken) {
  const resources = new URL(`${apiBase}/html-resource/${resourceToken}/`, requestUrl).href;
  const directory = path.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  const base = resources + (directory ? `${directory}/` : '');
  const documentUrl = new URL(`${apiBase}/html`, requestUrl);
  documentUrl.searchParams.set('path', path);
  const tree = parse(source);
  function clean(node) {
    if (node.tagName === 'a') {
      const href = node.attrs.find(attr => attr.name === 'href');
      if (href?.value.startsWith('#')) href.value = documentUrl.href + href.value;
      if (href) {
        try {
          const url = new URL(href.value, base);
          const withoutHash = new URL(url);
          withoutHash.hash = '';
          // Local resources stay inside the preview; ordinary web links open
          // independently so the destination is not subject to our sandbox.
          if (['http:', 'https:'].includes(url.protocol)
              && !url.href.startsWith(resources) && withoutHash.href !== documentUrl.href) {
            const target = node.attrs.find(attr => attr.name === 'target');
            if (target) target.value = '_blank';
            else node.attrs.push({ name: 'target', value: '_blank' });
            const rel = node.attrs.find(attr => attr.name === 'rel');
            const values = new Set((rel?.value || '').split(/\s+/).filter(Boolean));
            values.delete('opener');
            values.add('noopener');
            values.add('noreferrer');
            if (rel) rel.value = [...values].join(' ');
            else node.attrs.push({ name: 'rel', value: [...values].join(' ') });
          }
        } catch { /* Leave malformed URLs to the browser. */ }
      }
    }
    if (!node.childNodes) return;
    node.childNodes = node.childNodes.filter(child =>
      !['base', 'iframe', 'frame', 'frameset', 'object', 'embed'].includes(child.tagName) &&
      !(child.tagName === 'meta' && child.attrs.some(attr => attr.name === 'http-equiv')));
    for (const child of node.childNodes) clean(child);
    if (node.content) clean(node.content);
  }
  clean(tree);
  const html = tree.childNodes.find(node => node.tagName === 'html');
  if (!html.attrs.some(attr => attr.name === 'data-dim-images')) html.attrs.push({ name: 'data-dim-images', value: '' });
  const head = html.childNodes.find(node => node.tagName === 'head');
  const baseNode = parseFragment(`<base href="${base}">`).childNodes[0];
  baseNode.parentNode = head;
  head.childNodes.unshift(baseNode);
  const scrollbarStyle = parseFragment('<style>html, body { scrollbar-width: none !important; } html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }</style>').childNodes[0];
  scrollbarStyle.parentNode = head;
  head.childNodes.push(scrollbarStyle);
  // The opaque iframe cannot inherit the library's styles; follow the same
  // system theme inside the preview, including images inserted by its scripts.
  const imageStyle = parseFragment(`<style>${imageTheme}</style>`).childNodes[0];
  imageStyle.parentNode = head;
  head.childNodes.push(imageStyle);
  const csp = ["default-src 'none'", "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
    `script-src 'unsafe-inline' ${resources}`, `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`, `font-src data: ${resources}`, `media-src ${resources}`,
    `base-uri ${resources}`, "connect-src 'none'", "form-action 'none'",
    "frame-src 'none'", "object-src 'none'", "worker-src 'none'"].join('; ');
  return new Response(serialize(tree), { headers: {
    'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-dns-prefetch-control': 'off',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()',
  } });
}
