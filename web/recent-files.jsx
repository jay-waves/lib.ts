import React, { useEffect, useMemo, useState } from 'react';
import { historyFileGroups } from './history-groups.mjs';
import { apiBase } from './urls.mjs';
import { createRecentFilesClient } from './recent-files.mjs';
import './recent-files.css';

const client = createRecentFilesClient(`${apiBase}/recent-files`);
export function useRecentFiles(active, path) {
  const [items, setItems] = useState([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [visitedAt, setVisitedAt] = useState({});
  useEffect(() => client.subscribe((paths, times) => { setItems(paths); setVisitedAt(times); }), []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoading(true); setError('');
    // Path changes and tab activation record visits; document revisions do not.
    (path ? client.visit(path) : client.load()).catch(cause => { if (!disposed) setError(cause.message); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [active, path]);
  return { items, visitedAt, error, loading };
}
export function RecentFiles({ state, renderTree }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = setInterval(refresh, 60000);
    addEventListener('focus', refresh);
    return () => { clearInterval(timer); removeEventListener('focus', refresh); };
  }, []);
  const nodes = useMemo(() => historyFileGroups(state.items, state.visitedAt, now), [state.items, state.visitedAt, now]);
  return <nav className="recent-files" aria-label="Recent Files">
    {state.error && <div className="action-error" role="alert">{state.error}</div>}
    {!nodes.length && <div className="tree-empty">{state.loading ? 'Loading recent files…' : 'No recent files. Open a document to get started.'}</div>}
    {nodes.length > 0 && renderTree(nodes)}
  </nav>;
}
