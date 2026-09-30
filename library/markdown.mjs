import DOMPurify from 'dompurify';

const assetSelector = 'img[src], source[src], audio[src], video[src], video[poster]';
const sanitizeOptions = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ALLOW_DATA_ATTR: true,
};

function resolvedLocalPath(value, current) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  const directory = current.split('/').slice(0, -1).map(encodeURIComponent).join('/');
  const base = new URL(`http://notes.local/${directory ? `${directory}/` : ''}`);
  const resolved = new URL(value, base);
  return resolved.origin === base.origin ? decodeURIComponent(resolved.pathname.slice(1)) : null;
}

export function prepareMarkdown(document, linkFor) {
  const clean = DOMPurify.sanitize(document.html, sanitizeOptions);
  const dom = new DOMParser().parseFromString(clean, 'text/html');
  const assets = new Set();
  for (const element of dom.querySelectorAll(assetSelector)) {
    const attribute = element.hasAttribute('poster') ? 'poster' : 'src';
    const path = resolvedLocalPath(element.getAttribute(attribute), document.path);
    if (!path) continue;
    assets.add(path);
    element.setAttribute(attribute, `/api/asset?path=${encodeURIComponent(path)}`);
    element.setAttribute('data-library-asset-path', path);
    element.setAttribute('data-library-asset-attribute', attribute);
  }
  for (const link of dom.querySelectorAll('a[href]')) {
    const path = resolvedLocalPath(link.getAttribute('href'), document.path);
    if (path) link.href = linkFor(path);
  }
  return { html: DOMPurify.sanitize(dom.body.innerHTML, sanitizeOptions), assets: [...assets] };
}

export function updateAssetVersions(root, versions) {
  root?.querySelectorAll('[data-library-asset-path]').forEach(element => {
    const path = element.getAttribute('data-library-asset-path');
    const version = versions[path];
    if (!version) return;
    const attribute = element.getAttribute('data-library-asset-attribute');
    element.setAttribute(attribute, `/api/asset?path=${encodeURIComponent(path)}&v=${version}`);
  });
}
