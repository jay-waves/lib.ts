import { useCallback, useEffect, useState } from 'react';
import { ActionList } from '@primer/react';
import { apiBase } from '../urls.mjs';
import { getBookmarks, setBookmark as saveBookmark } from '../api/library';
import { bookmarkPositionKey } from './bookmark-position.mjs';
import type { Bookmark } from '../api/contracts';

export type BookmarkState = ReturnType<typeof useBookmarks>;

export function useBookmarks(active = true) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!apiBase) {
      setLoading(false);
      setError('');
      setBookmarks([]);
      return;
    }
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    getBookmarks(apiBase, controller.signal).then(setBookmarks)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision, active]);
  const setBookmark = useCallback(async (path: string, bookmarked: boolean, line?: number, page?: Bookmark['page']) => {
    setSaving(true);
    setError('');
    try {
      if (!apiBase) throw new Error('Bookmarks are available only inside a repository.');
      setBookmarks(await saveBookmark(apiBase, path, bookmarked, line, page));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, []);
  return { bookmarks, loading, saving, error, setBookmark, refresh: () => setRevision(value => value + 1) };
}

export function BookmarkMenu({ state, path, line, page, disabled = false }: {
  state: BookmarkState; path: string; line?: number; page?: Bookmark['page']; disabled?: boolean;
}) {
  const targetLine = page ? undefined : line ?? 1;
  const bookmarked = state.bookmarks.some(item => item.path === path
    && bookmarkPositionKey(item) === bookmarkPositionKey({ line: targetLine, page }));
  return <ActionList.Item disabled={disabled || state.loading || state.saving}
    onSelect={() => state.setBookmark(path, !bookmarked, targetLine, page)}>
    {bookmarked ? 'Remove bookmark' : 'Add bookmark'}
  </ActionList.Item>;
}
