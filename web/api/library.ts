import { requestJson, requestJsonWithResponse } from './client';
import {
  bookmarksResponseSchema,
  type Bookmark,
  setBookmarkSchema,
  treeEvents,
  treeSchema,
  openDirectoryResponseSchema,
} from './contracts';
import { subscribeEvents } from './events';

export async function getFileTree(apiBase: string, signal?: AbortSignal, showHidden = false) {
  const { data, response } = await requestJsonWithResponse(`${apiBase}/tree?showHidden=${showHidden}`, treeSchema, { signal });
  return { ...data, revision: response.headers.get('x-tree-revision') };
}

export async function getBookmarks(apiBase: string, signal?: AbortSignal) {
  return (await requestJson(`${apiBase}/bookmarks`, bookmarksResponseSchema, { signal })).bookmarks;
}

export async function setBookmark(apiBase: string, path: string, bookmarked: boolean, line?: number, page?: Bookmark['page']) {
  const body = setBookmarkSchema.parse({ path, bookmarked, line, page });
  return (await requestJson(`${apiBase}/bookmarks`, bookmarksResponseSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).bookmarks;
}

export function watchFileTree(
  apiBase: string,
  onRevision: (revision: string) => void,
  showHidden = false,
) {
  return subscribeEvents(`${apiBase}/library/tree-events?showHidden=${showHidden}`, treeEvents, {
    tree: ({ revision }) => onRevision(revision),
    connected: ({ revision }) => onRevision(revision),
  });
}

export function openDirectory(apiBase: string, path = '') {
  return requestJson(`${apiBase}/open-directory`, openDirectoryResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}
