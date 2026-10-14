import React, { useEffect, useId, useRef, useState } from 'react';
import { Banner, CounterLabel, IconButton, Spinner } from '@primer/react';
import { ArrowUpIcon, ArrowUpRightIcon, FoldIcon, UnfoldIcon, XIcon } from '@primer/octicons-react';
import { apiBase } from './urls.mjs';
import './git-diff.css';

function Hunk({ hunk }) {
  const [expanded, setExpanded] = useState(hunk.lines.length <= 400);
  const contentId = useId();
  const toggle = () => setExpanded(value => !value);
  return <>
    <button type="button" className="git-diff-hunk" aria-expanded={expanded} aria-controls={contentId} onClick={toggle}>
      <span className="git-diff-fold-gutter" aria-hidden="true">{expanded ? <FoldIcon size={16} /> : <UnfoldIcon size={16} />}</span>
      <span>{hunk.header}</span>
    </button>
    <div id={contentId} className="git-diff-lines" role="table" aria-label="Diff lines" hidden={!expanded}>
      {expanded && hunk.lines.map((line, index) => <div className={`git-diff-line is-${line.kind}`} role="row" key={index}>
        <span className="git-diff-number" role="cell" aria-label={line.oldLine ? `Old line ${line.oldLine}` : undefined}>{line.oldLine}</span>
        <span className="git-diff-number" role="cell" aria-label={line.newLine ? `New line ${line.newLine}` : undefined}>{line.newLine}</span>
        <span className="git-diff-sign" role="cell">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : line.kind === 'note' ? '\\' : ' '}</span>
        <code role="cell">{line.text || ' '}</code>
      </div>)}
    </div>
  </>;
}

function Section({ section }) {
  const metadata = section.id === 'untracked' ? [] : section.metadata;
  return <section className="git-diff-section" aria-label={section.label}>
      {metadata.length > 0 && <div className="git-diff-message">{metadata.map((text, index) => <div key={index}>{text}</div>)}</div>}
      {section.binary ? <p className="git-diff-message">Binary file changed. Text diff is unavailable.</p>
        : section.tooLarge ? <p className="git-diff-message">This diff exceeds the 2 MB preview limit. View it with a local Git client.</p>
        : !section.hunks.length ? <p className="git-diff-message">No text changes.</p>
        : section.hunks.map((hunk, index) => <Hunk key={`${index}:${hunk.header}`} hunk={hunk} />)}
  </section>;
}

export default function GitDiffView({ path, scope, active, revision, onOpen, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef(null);
  const sections = data?.sections || [];
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const panel = sentinel?.closest('.main-panel');
    if (!sentinel || !panel || !active) return;
    const observer = new IntersectionObserver(([entry]) => {
      setStuck(Boolean(entry.rootBounds && entry.boundingClientRect.bottom <= entry.rootBounds.top));
    }, { root: panel, threshold: [0, 1] });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    fetch(`${apiBase}/git/diff?path=${encodeURIComponent(path)}&scope=${scope}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Git diff API is unavailable. Restart the library service.');
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || 'Could not load diff.');
        if (!controller.signal.aborted) { setData(value); setError(''); }
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [path, scope, active, revision]);
  const label = sections.some(section => section.id === 'untracked') ? 'Untracked Changes'
    : scope === 'staged' ? 'Staged Changes' : scope === 'conflict' ? 'Merge Changes' : 'Unstaged Changes';
  return <div className="content-panel git-diff-view">
    <div className="toolbar-sentinel" ref={sentinelRef} aria-hidden="true" />
    <div className="git-diff-toolbar">
      <strong className="git-diff-title">{label}</strong>
        {data && <><CounterLabel className="git-diff-added">+{sections.reduce((total, section) => total + section.additions, 0)}</CounterLabel>{' '}
        <CounterLabel className="git-diff-deleted">−{sections.reduce((total, section) => total + section.deletions, 0)}</CounterLabel></>}
      <span className="git-diff-toolbar-spacer" />
      {stuck && <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
        onClick={() => sentinelRef.current?.closest('.main-panel')?.scrollTo({ top: 0, behavior: 'instant' })} />}
      {onOpen && <IconButton size="small" variant="invisible" icon={ArrowUpRightIcon} aria-label="Open file" onClick={onOpen} />}
      <IconButton size="small" variant="invisible" icon={XIcon} aria-label="Close diff" onClick={onClose} />
    </div>
    {error && <Banner variant="critical" layout="compact" title="Could not load diff" description={error} />}
    {!data && !error && <div className="git-diff-message" role="status"><Spinner size="small" /> Loading diff…</div>}
    {data?.originalPath && <p className="git-diff-message">{data.originalPath} → {path}</p>}
    {data?.conflict && <Banner variant="warning" layout="compact" title="Unresolved conflict"
      description="The working file is compared with our side of the merge." />}
    {data?.clean && <p className="git-diff-message">This file no longer has changes in {label}.</p>}
    {sections.map(section => <Section key={section.id} section={section} />)}
  </div>;
}
