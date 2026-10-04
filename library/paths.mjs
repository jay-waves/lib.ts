const nameOf = repo => typeof repo === 'string' ? repo : repo.slug;
const encodedSegments = path => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const repoPath = repo => `/${encodeURIComponent(nameOf(repo))}`;

export function parseRepositoryLocation(pathname) {
  const parts = pathname.split('/');
  if (parts.length < 3 || parts[0] || !parts[1] || !['tree', 'search', 'git'].includes(parts[2])) return null;
  const kind = parts[2];
  if (kind !== 'tree' && (parts.length > 4 || (parts.length === 4 && parts[3]))) return null;
  try {
    return { repo: decodeURIComponent(parts[1]), kind,
      path: kind === 'tree' ? parts.slice(3).filter(Boolean).map(decodeURIComponent).join('/') : '' };
  } catch {
    return null;
  }
}

export function repositoryUrl(repo) { return `${repoPath(repo)}/tree/`; }
export function documentUrl(repo, path = '', directory = false) {
  const encoded = encodedSegments(path);
  return encoded ? `${repoPath(repo)}/tree/${encoded}${directory ? '/' : ''}` : repositoryUrl(repo);
}
export function repositoryApiUrl(repo, endpoint = '') {
  const encoded = encodedSegments(endpoint);
  return `${repoPath(repo)}/api${encoded ? `/${encoded}` : ''}`;
}
export function searchUrl(repo, query = '', scope = '', currentFile = '') {
  const url = `${repoPath(repo)}/search`;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (scope) params.set('scope', scope);
  if (currentFile) params.set('file', currentFile);
  return params.size ? `${url}?${params}` : url;
}
export function gitUrl(repo, path = '', scope = 'unstaged') {
  const url = `${repoPath(repo)}/git`;
  return path ? `${url}?${new URLSearchParams({ path, scope })}` : url;
}
