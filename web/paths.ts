// Repository route segments are URL encoded independently; API paths stay relative
// to the repository root. Filesystem breadcrumbs also handle drive and UNC roots.
type Repository = string | { slug: string };

/** Absolute filesystem breadcrumbs with a machine or network-server entry. */
export function directoryPathSegments(path: string, machine: { hostname: string; rootPath: string }): { label: string; path?: string }[] {
  const drive = path.match(/^[a-z]:[\\/]/i)?.[0];
  const share = path.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/);
  const root = drive || share?.[0] || (path.startsWith('/') ? '/' : '');
  const windows = Boolean(drive || share);
  const separator = drive ? drive[2] : share ? share[0][0] : '/';
  const parts = path.slice(root.length).split(windows ? /[\\/]+/ : /\/+/);
  const items: { label: string; path?: string }[] = share
    ? [{ label: share[1] }, { label: share[2], path: root }]
    : [{ label: machine.hostname, path: machine.rootPath }];
  if (drive) items.push({ label: drive.slice(0, 2), path: drive });
  let current = root;
  for (const label of parts.filter(Boolean)) {
    current += (current && !current.endsWith(separator) ? separator : '') + label;
    items.push({ label, path: current });
  }
  return items;
}

const nameOf = (repo: Repository) => typeof repo === 'string' ? repo : repo.slug;
const encodedSegments = (path: string) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const repoPath = (repo: Repository) => `/${encodeURIComponent(nameOf(repo))}`;

export function parseRepositoryLocation(pathname: string) {
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

export function repositoryUrl(repo: Repository) { return `${repoPath(repo)}/tree/`; }
export function documentUrl(repo: Repository, path = '', directory = false) {
  const encoded = encodedSegments(path);
  return encoded ? `${repoPath(repo)}/tree/${encoded}${directory ? '/' : ''}` : repositoryUrl(repo);
}
export function repositoryApiUrl(repo: Repository, endpoint = '') {
  const encoded = encodedSegments(endpoint);
  return `${repoPath(repo)}/api${encoded ? `/${encoded}` : ''}`;
}
export function searchUrl(repo: Repository, query = '', scope = '', currentFile = '') {
  const url = `${repoPath(repo)}/search`;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (scope) params.set('scope', scope);
  if (currentFile) params.set('file', currentFile);
  return params.size ? `${url}?${params}` : url;
}
export function gitUrl(repo: Repository, path = '', scope = 'unstaged') {
  const url = `${repoPath(repo)}/git`;
  return path ? `${url}?${new URLSearchParams({ path, scope })}` : url;
}
