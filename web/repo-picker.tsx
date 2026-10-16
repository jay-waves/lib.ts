import { syncReadingPositions } from './reading-state.mjs';
import React, { useEffect, useRef, useState, type MouseEvent } from 'react';
import { FileDirectoryIcon, RepoIcon, PlusIcon } from '@primer/octicons-react';
import { repoId } from './urls.mjs';
import { PathBar } from './path-bar';
import { directoryPathSegments } from './paths';
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
  const [machine, setMachine] = useState<{ hostname: string; rootPath: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setDirectory(null);
    browseDirectories(requestedPath, controller.signal)
      .then(listing => { setDirectory(listing); setMachine({ hostname: listing.hostname, rootPath: listing.rootPath }); })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorMessage(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requestedPath]);
  async function add() {
    if (!directory?.path) return;
    setAdding(true); setError('');
    try {
      const repo = await registerRepository(directory.path);
      dispatchEvent(new Event('reading-capture'));
      await syncReadingPositions();
      await beforeNavigate();
      location.assign(repo.url);
    } catch (cause) { setError(errorMessage(cause)); setAdding(false); }
  }
  return <dialog ref={dialog} className="box-border w-[min(620px,calc(100vw-32px))] max-h-[calc(100dvh-48px)] overflow-hidden rounded-ui border border-solid border-border bg-surface p-0 font-ui text-ui text-fg open:flex open:flex-col backdrop:bg-black/30 [&_button]:ui-focus [&_button]:font-ui [&_button]:cursor-pointer [&_button:disabled]:opacity-55 [&_button:disabled]:cursor-default" onCancel={event => { event.preventDefault(); if (!adding) onClose(); }}
    aria-label="Add repository">
    <div className="flex min-h-toolbar flex-none items-center border-0 border-b border-solid border-divider px-6 py-2">
      <PathBar items={machine ? directoryPathSegments(directory?.path ?? requestedPath, machine) : []} disabled={adding}
        onNavigate={setRequestedPath} />
    </div>
    <div className="h-[min(320px,40dvh)] min-h-0 overflow-auto overscroll-contain px-4 py-2" aria-busy={loading}>
      {loading ? <p className="p-2 text-muted">Loading directories…</p> : <>
        {!error && directory?.directories.map(child => <button type="button" key={child.path} className="ui-focus flex min-h-row w-full box-border items-center gap-2 rounded-ui border-0 bg-transparent px-2 py-1.5 text-start leading-5 text-inherit hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted" disabled={adding} onClick={() => setRequestedPath(child.path)}><FileDirectoryIcon size={16} /><span className="min-w-0 truncate">{child.name}</span></button>)}
        {!error && !directory?.directories.length && <p className="p-2 text-muted">No subdirectories</p>}
      </>}
    </div>
    {error && <p className="m-0 flex-none px-6 pt-2 pb-3 text-meta text-danger [overflow-wrap:anywhere]" role="alert">{error}</p>}
    <div className="flex flex-none flex-wrap items-center justify-end gap-2 p-4">
      <button type="button" className="ui-button border-0! bg-transparent!" disabled={adding} onClick={onClose}>Cancel</button>
      <button type="button" className="ui-button border-divider! bg-selected! font-medium!" disabled={loading || adding || !directory?.path} onClick={add}>{adding ? 'Adding…' : 'Add repository'}</button></div>
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
        if (!cancelled) {
          setActiveId(selected?.id || null);
          // Keep positions stable when opening a repository updates its last-used time.
          setRepos([...initial.repos].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
        }
        if (!selected) return;
        await markRepositoryUsed(selected.apiUrl);
      } catch (cause) { if (!cancelled) setError(errorMessage(cause)); }
    })();
    return () => { cancelled = true; };
  }, []);
  const active = repos.find(repo => repo.id === activeId);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-ui [&[hidden]]:hidden" hidden={hidden}>
    <nav className="flex min-h-0 flex-1 flex-col-reverse overflow-auto overscroll-y-none px-2 py-sidebar-top" aria-label="Repositories">
      <div className="flex flex-none flex-col gap-2">
        <button type="button" className="ui-focus flex-none flex min-h-row w-full box-border cursor-pointer items-center gap-2 rounded-ui border-0 bg-transparent px-2 py-1.5 text-start font-ui text-ui text-muted hover:bg-hover hover:text-fg [&>svg]:shrink-0" onClick={() => setOpen(true)}><PlusIcon size={16} />Add repository</button>
        {error && <p className="m-2 flex-none text-meta text-danger [overflow-wrap:anywhere]" role="alert">{error}</p>}
        <div className="flex flex-none flex-col-reverse gap-1">{repos.map(repo => <a className="sidebar-list-item group grid grid-cols-[16px_minmax(0,1fr)] items-center gap-2 px-2 py-1.5 font-normal text-fg no-underline" key={repo.id} href={repo.url} onClick={async (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          dispatchEvent(new Event('reading-capture'));
          try { await syncReadingPositions(); await beforeNavigate(); location.assign(repo.url); }
          catch (cause) { setError(errorMessage(cause)); }
        }} aria-current={repo.id === activeId ? 'page' : undefined}>
          <span className="flex h-5 items-center text-muted" aria-hidden="true"><RepoIcon size={16} /></span>
          <span className="sidebar-path path-label text-ui group-aria-[current=page]:font-semibold group-aria-[current=location]:font-semibold"><bdi dir="ltr">{repo.root}</bdi></span></a>)}</div>
      </div>
    </nav>
    {open && <DirectoryPicker beforeNavigate={beforeNavigate} initialPath={active?.root} onClose={() => setOpen(false)} />}
  </div>;
}
