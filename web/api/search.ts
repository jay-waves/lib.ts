import { requestJson } from './client.ts';
import { searchResponseSchema, type SearchResponse } from './contracts.ts';

export type RepositorySearchScope = '' | 'current-file';
export type SearchRequest = {
  query: string;
  currentFile: string;
  scope: RepositorySearchScope;
} & (
  | { refresh: true; searchId?: never; offset?: never }
  | { searchId: string; offset?: number; refresh?: never }
);

export async function searchRepository(
  apiBase: string,
  request: SearchRequest,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  if (request.scope !== '' && request.scope !== 'current-file') throw new Error('Unsupported search scope.');
  const params = new URLSearchParams({ q: request.query, currentFile: request.currentFile });
  if (request.scope) params.set('scope', request.scope);
  if (request.refresh) params.set('refresh', 'true');
  else {
    params.set('searchId', request.searchId);
    if (request.offset !== undefined) {
      if (!Number.isSafeInteger(request.offset) || request.offset < 0) throw new Error('Invalid search offset.');
      params.set('offset', String(request.offset));
    }
  }
  const result = await requestJson(`${apiBase}/search?${params}`, searchResponseSchema, { signal });
  if (request.searchId !== undefined && result.searchId !== request.searchId) {
    throw new Error('Search snapshot changed. Retry the search.');
  }
  return result;
}
