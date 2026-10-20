// Legacy file bookmarks denote the beginning of the file.
export function bookmarkPositionKey(bookmark) {
  return bookmark.page
    ? `page:${bookmark.page.index}:${bookmark.page.x}:${bookmark.page.y}`
    : `line:${bookmark.line ?? 1}`;
}

export function bookmarkMatchesRequest(bookmark, request) {
  return bookmark.path === request.path && !!(request.line || request.page)
    && bookmarkPositionKey(bookmark) === bookmarkPositionKey(request);
}
