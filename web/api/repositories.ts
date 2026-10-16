import { requestJson } from './client';
import {
  directoryListingSchema,
  repositoriesResponseSchema,
  repositoryMetadataSchema,
  type DirectoryListing,
  type RepositoryMetadata,
} from './contracts';

export function browseDirectories(path: string, signal?: AbortSignal): Promise<DirectoryListing> {
  const query = new URLSearchParams(path ? { path } : { root: 'true' });
  return requestJson(`/api/directories?${query}`, directoryListingSchema, { signal });
}

export async function listRepositories(): Promise<{
  repos: RepositoryMetadata[];
  defaultRepoId?: string | null;
}> {
  return requestJson('/api/repos', repositoriesResponseSchema);
}

export function registerRepository(root: string): Promise<RepositoryMetadata> {
  return requestJson('/api/repos', repositoryMetadataSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
}

export function markRepositoryUsed(apiUrl: string): Promise<RepositoryMetadata> {
  return requestJson(`${apiUrl}/use`, repositoryMetadataSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}
