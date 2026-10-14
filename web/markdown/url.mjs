export function resolveMarkdownUrl(value, current) {
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)) return null;
  const rawPath = value.split(/[?#]/, 1)[0];
  const rootRelative = rawPath.startsWith('/');
  const parts = rootRelative ? [] : (rawPath ? current.split('/').slice(0, -1) : current.split('/'));
  try {
    for (const rawPart of rawPath.split('/')) {
      // A bare percent is a valid filename character in Markdown destinations;
      // keep it literal while decoding real URI escapes such as %20 and %E4.
      const part = decodeURIComponent(rawPart.replace(/%(?![\da-f]{2})/gi, '%25'));
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else {
        if (part.includes('/') || part.includes('\\')) return null;
        parts.push(part);
      }
    }
    const basePath = `/${current.split('/').map(encodeURIComponent).join('/')}`;
    const resolved = new URL(value, `http://notes.local${basePath}`);
    if (resolved.origin !== 'http://notes.local') return null;
    return { path: parts.join('/'), search: resolved.search, hash: resolved.hash };
  } catch {
    return null;
  }
}
