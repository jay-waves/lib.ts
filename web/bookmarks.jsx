import React, { useCallback, useEffect, useState } from 'react';
import { ActionList } from '@primer/react';
import { apiBase } from './urls.mjs';

async function request(options) {
  const response = await fetch(`${apiBase}/bookmarks`, options);
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Bookmarks are unavailable. Restart the preview server to load the Bookmarks API.');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not save bookmarks.');
  return value.bookmarks;
}

export function useBookmarks(active = true) {
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    request({ signal: controller.signal }).then(setBookmarks)
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision, active]);
  const setBookmark = useCallback(async (path, bookmarked) => {
    setSaving(true); setError('');
    try {
      setBookmarks(await request({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, bookmarked }) }));
    } catch (cause) { setError(cause.message); }
    finally { setSaving(false); }
  }, []);
  return { bookmarks, loading, saving, error, setBookmark, refresh: () => setRevision(value => value + 1) };
}

export function BookmarkMenu({ state, path }) {
  const bookmarked = state.bookmarks.some(item => item.path === path);
  return <ActionList.Item disabled={state.loading || state.saving} onSelect={() => state.setBookmark(path, !bookmarked)}>
    {bookmarked ? 'Remove bookmark' : 'Add bookmark'}
  </ActionList.Item>;
}
