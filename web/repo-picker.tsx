import { syncReadingPositions } from './reading-state.mjs';
import React, { useEffect, useRef, useState, type MouseEvent } from 'react';
import { FileDirectoryIcon, ArrowUpIcon, XIcon } from '@primer/octicons-react';
import { repoId } from './urls.mjs';
import styles from './repo-picker.module.css';
import { browseDirectories, listRepositories, markRepositoryUsed, registerRepository } from './api/repositories';
import type { DirectoryListing, RepositoryMetadata } from './api/contracts';

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface DirectoryPickerProps {
  initialPath?: string;
  onClose(): void;
  beforeNavigate(): Promise<void>;
}

function DirectoryPicker({ initialPath, onClose, beforeNavigate }: DirectoryPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [requestedPath, setRequestedPath] = useState(initialPath || '');
  const [directory, setDirectory] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setDirectory(null);
    browseDirectories(requestedPath, controller.signal)
      .then(setDirectory)
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorMessage(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestedPath]);
  async function add() {
    if (!directory) return;
    setAdding(true); setError('');
    try {
      const repo = await registerRepository(directory.path);
      dispatchEvent(new Event('reading-capture'));
      await syncReadingPositions();
      await beforeNavigate();
      location.assign(repo.url);
    } catch (cause) { setError(errorMessage(cause)); setAdding(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} onCancel={event => { event.preventDefault(); if (!adding) onClose(); }}
    aria-labelledby="repo-directory-title">
    <div className={styles.header}><h2 id="repo-directory-title">Add repository</h2>
      <button type="button" className={styles.textButton} aria-label="Close directory browser" disabled={adding} onClick={onClose}><XIcon size={18} /></button></div>
    <div className={styles.drives}>{directory?.drives.map(drive => <button type="button" key={drive.path} disabled={adding}
      onClick={() => setRequestedPath(drive.path)}>{drive.name}</button>)}</div>
    <div className={styles.entries} aria-busy={loading}>
      {loading ? <p>Loading directories…</p> : <>
        {directory?.parent && <button type="button" disabled={adding} onClick={() => setRequestedPath(directory.parent ?? '')}><ArrowUpIcon size={16} />Parent directory</button>}
        {!error && directory?.directories.map(child => <button type="button" key={child.path} disabled={adding} onClick={() => setRequestedPath(child.path)}><FileDirectoryIcon size={16} />{child.name}</button>)}
        {!error && !directory?.directories.length && <p>No subdirectories</p>}
      </>}
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.footer}><span title={directory?.path}>{directory?.path}</span>
      <button type="button" className={styles.addButton} disabled={loading || adding || !directory} onClick={add}>{adding ? 'Adding…' : 'Add this directory'}</button></div>
  </dialog>;
}

interface RepoPickerProps {
  hidden?: boolean;
  beforeNavigate?: () => Promise<void>;
}

export function RepoPicker({ hidden = false, beforeNavigate = async () => {} }: RepoPickerProps) {
  const [repos, setRepos] = useState<RepositoryMetadata[]>([]);
  const [activeId, setActiveId] = useState(repoId);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await listRepositories();
        const selected = initial.repos.find(repo => repo.slug === repoId || repo.id === repoId)
          || initial.repos.find(repo => repo.id === initial.defaultRepoId);
        if (!cancelled) { setActiveId(selected?.id || null); setRepos(initial.repos); }
        if (!selected) return;
        await markRepositoryUsed(selected.apiUrl);
        const updated = await listRepositories();
        if (!cancelled) setRepos(updated.repos);
      } catch (cause) { if (!cancelled) setError(errorMessage(cause)); }
    })();
    return () => { cancelled = true; };
  }, []);
  const active = repos.find(repo => repo.id === activeId);
  return <div className={styles.picker} hidden={hidden}>
    <nav aria-label="Repositories by recent use">
      <div className={styles.list}>{repos.map(repo => <a key={repo.id} href={repo.url} onClick={async (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        dispatchEvent(new Event('reading-capture'));
        try { await syncReadingPositions(); await beforeNavigate(); location.assign(repo.url); }
        catch (cause) { setError(errorMessage(cause)); }
      }} title={repo.root} aria-current={repo.id === activeId ? 'page' : undefined}>
        <span>{repo.name}</span><small>{repo.root}</small></a>)}</div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" className={styles.addMore} onClick={() => setOpen(true)}>add more</button>
    </nav>
    {open && <DirectoryPicker beforeNavigate={beforeNavigate} initialPath={active?.root} onClose={() => setOpen(false)} />}
  </div>;
}
