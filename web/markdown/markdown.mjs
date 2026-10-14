import { apiBase } from '../urls.mjs';
import DOMPurify from 'dompurify';
import { resolveMarkdownUrl } from './url.mjs';

const assetSelector = 'img[src], source[src], audio[src], video[src], video[poster]';
const sanitizeOptions = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  ALLOW_DATA_ATTR: true,
};

function assetUrl(path, search = '', hash = '') {
  const params = new URLSearchParams(search);
  params.set('path', path);
  return `${apiBase}/asset?${params}${hash}`;
}

export function prepareMarkdown(document, linkFor) {
  const body = DOMPurify.sanitize(document.html, { ...sanitizeOptions, RETURN_DOM: true });
  const assets = new Set();
  for (const element of body.querySelectorAll(assetSelector)) {
    const attribute = element.hasAttribute('poster') ? 'poster' : 'src';
    const resolved = resolveMarkdownUrl(element.getAttribute(attribute), document.path);
    if (!resolved) continue;
    const { path, search, hash } = resolved;
    assets.add(path);
    element.setAttribute(attribute, assetUrl(path, search, hash));
    element.setAttribute('data-library-asset-path', path);
    element.setAttribute('data-library-asset-attribute', attribute);
    element.setAttribute('data-library-asset-search', search);
    element.setAttribute('data-library-asset-hash', hash);
  }
  for (const link of body.querySelectorAll('a[href]')) {
    const resolved = resolveMarkdownUrl(link.getAttribute('href'), document.path);
    if (resolved) link.href = `${linkFor(resolved.path)}${resolved.search}${resolved.hash}`;
    else if (/^https?:\/\//i.test(link.href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
  }
  // Keep the final security check after URL rewriting, without serializing and
  // reparsing HTML. The preview clones these already-sanitized nodes directly.
  DOMPurify.sanitize(body, { ...sanitizeOptions, IN_PLACE: true });
  return { body, assets: [...assets] };
}

export function updateAssetVersions(root, versions) {
  root?.querySelectorAll('[data-library-asset-path]').forEach(element => {
    const path = element.getAttribute('data-library-asset-path');
    const version = versions[path];
    if (!version) return;
    const attribute = element.getAttribute('data-library-asset-attribute');
    const params = new URLSearchParams(element.getAttribute('data-library-asset-search') || '');
    params.set('path', path);
    params.set('v', version);
    const hash = element.getAttribute('data-library-asset-hash') || '';
    element.setAttribute(attribute, `${apiBase}/asset?${params}${hash}`);
  });
}
