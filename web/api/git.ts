import { requestJson } from './client';
import { gitDiffResponseSchema, type GitDiffResponse } from './contracts';

export function getGitDiff(
  apiBase: string,
  path: string,
  scope: string,
  signal?: AbortSignal,
): Promise<GitDiffResponse> {
  const params = new URLSearchParams({ path, scope });
  return requestJson(`${apiBase}/git/diff?${params}`, gitDiffResponseSchema, {
    signal,
    cache: 'no-store',
  });
}
