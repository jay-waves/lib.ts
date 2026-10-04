import { repositoryApiUrl, repositoryUrl, documentUrl, searchUrl, gitUrl, parseRepositoryLocation } from './paths.mjs';

// URL names are folder names; stable IDs remain internal to the registry.
const current = parseRepositoryLocation(globalThis.location?.pathname || '');
export const repoId = current?.repo || null;
export const routeKind = current?.kind || null;
export const pageBase = repoId ? repositoryUrl(repoId).replace(/\/$/, '') : '';
export const searchBase = repoId ? searchUrl(repoId) : '';
export const gitBase = repoId ? gitUrl(repoId) : '';
export const apiBase = repoId ? repositoryApiUrl(repoId) : '';
export const treeBase = repoId ? repositoryUrl(repoId) : '';
export const fileUrl = (path, directory = false) => documentUrl(repoId, path, directory);
