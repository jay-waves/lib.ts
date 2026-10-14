import { syncReadingPositions } from './reading-state.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { FileDirectoryIcon, ArrowUpIcon, XIcon } from '@primer/octicons-react';
import { repoId } from './urls.mjs';

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
const jsonPost = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function DirectoryPicker({ initialPath, onClose, beforeNavigate }) {
  const dialog = useRef(null);
  const [requestedPath, setRequestedPath] = useState(initialPath || '');
  const [directory, setDirectory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setDirectory(null);
    request(`/api/directories?${new URLSearchParams({ path: requestedPath })}`, { signal: controller.signal })
      .then(value => { setDirectory(value); })
      .catch(error => { if (error.name !== 'AbortError') setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestedPath]);
  async function add() {
    setAdding(true); setError('');
    try {
      const repo = await request('/api/repos', jsonPost({ root: directory.path }));
      dispatchEvent(new Event('reading-capture'));
      await syncReadingPositions();
      await beforeNavigate();
      location.assign(repo.url);
    } catch (error) { setError(error.message); setAdding(false); }
  }
  return <dialog ref={dialog} className="repo-directory-dialog" onCancel={event => { event.preventDefault(); if (!adding) onClose(); }}
    aria-labelledby="repo-directory-title">
    <div className="repo-directory-header"><h2 id="repo-directory-title">Add repository</h2>
      <button type="button" className="repo-text-button" aria-label="Close directory browser" disabled={adding} onClick={onClose}><XIcon size={18} /></button></div>
    <div className="repo-drives">{directory?.drives.map(drive => <button type="button" key={drive.path} disabled={adding}
      onClick={() => setRequestedPath(drive.path)}>{drive.name}</button>)}</div>
    <div className="repo-directory-list" aria-busy={loading}>
      {loading ? <p>Loading directories…</p> : <>
        {directory?.parent && <button type="button" disabled={adding} onClick={() => setRequestedPath(directory.parent)}><ArrowUpIcon size={16} />Parent directory</button>}
        {!error && directory?.directories.map(child => <button type="button" key={child.path} disabled={adding} onClick={() => setRequestedPath(child.path)}><FileDirectoryIcon size={16} />{child.name}</button>)}
        {!error && !directory?.directories.length && <p>No subdirectories</p>}
      </>}
    </div>
    {error && <p className="repo-picker-error" role="alert">{error}</p>}
    <div className="repo-directory-footer"><span title={directory?.path}>{directory?.path}</span>
      <button type="button" className="repo-add-button" disabled={loading || adding || !directory} onClick={add}>{adding ? 'Adding…' : 'Add this directory'}</button></div>
  </dialog>;
}

export function RepoPicker({ hidden = false, beforeNavigate = async () => {} }) {
  const [repos, setRepos] = useState([]);
  const [activeId, setActiveId] = useState(repoId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await request('/api/repos');
        const selected = initial.repos.find(repo => repo.slug === repoId || repo.id === repoId)
          || initial.repos.find(repo => repo.id === initial.defaultRepoId);
        if (!cancelled) { setActiveId(selected?.id || null); setRepos(initial.repos); }
        if (!selected) return;
        await request(`${selected.apiUrl}/use`, jsonPost({}));
        const updated = await request('/api/repos');
        if (!cancelled) setRepos(updated.repos);
      } catch (error) { if (!cancelled) setError(error.message); }
    })();
    return () => { cancelled = true; };
  }, []);
  const active = repos.find(repo => repo.id === activeId);
  return <div className="repo-picker tree-scroll" hidden={hidden}>
    <nav aria-label="Repositories by recent use">
      <div className="repo-picker-list">{repos.map(repo => <a key={repo.id} href={repo.url} onClick={async event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        dispatchEvent(new Event('reading-capture'));
        try { await syncReadingPositions(); await beforeNavigate(); location.assign(repo.url); }
        catch (cause) { setError(cause.message); }
      }} title={repo.root} aria-current={repo.id === activeId ? 'page' : undefined}>
        <span>{repo.name}</span><small>{repo.root}</small></a>)}</div>
      {error && <p className="repo-picker-error" role="alert">{error}</p>}
      <button type="button" className="repo-add-more" onClick={() => setOpen(true)}>add more</button>
    </nav>
    {open && <DirectoryPicker beforeNavigate={beforeNavigate} initialPath={active?.root} onClose={() => setOpen(false)} />}
  </div>;
}
