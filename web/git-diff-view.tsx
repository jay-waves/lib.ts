import { IconButton } from '@primer/react';
import React, { useEffect, useId, useRef, useState } from 'react';
import { Banner, Spinner } from '@primer/react';
import { ArrowUpIcon, ArrowUpRightIcon, FoldIcon, UnfoldIcon, XIcon } from '@primer/octicons-react';
import { apiBase } from './urls.mjs';
import { getGitDiff } from './api/git';
import type { GitDiffResponse } from './api/contracts';

type GitHunk = GitDiffResponse['sections'][number]['hunks'][number];
type GitSection = GitDiffResponse['sections'][number];

function Hunk({ hunk }: { hunk: GitHunk }) {
  const [expanded, setExpanded] = useState(hunk.lines.length <= 400);
  const contentId = useId();
  const toggle = () => setExpanded(value => !value);
  return <>
    <button type="button" className="ui-focus flex min-h-row w-full box-border cursor-pointer items-center gap-2 border-0 bg-selected px-3.5 py-0 text-left font-code text-ui! leading-5 text-muted [overflow-wrap:anywhere] hover:text-accent focus-visible:text-accent" aria-expanded={expanded} aria-controls={contentId} onClick={toggle}>
      <span className="flex w-4 flex-none items-center justify-center" aria-hidden="true">{expanded ? <FoldIcon size={16} /> : <UnfoldIcon size={16} />}</span>
      <span>{hunk.header}</span>
    </button>
    <div id={contentId} className="overflow-x-auto font-code text-meta leading-5 [tab-size:4]" role="table" aria-label="Diff lines" hidden={!expanded}>
      {expanded && hunk.lines.map((line, index) => <div className="flex min-w-full w-max data-[kind=add]:bg-[light-dark(#dafbe1,#12261e)] data-[kind=delete]:bg-[light-dark(#ffebe9,#331a1e)] data-[kind=note]:text-muted data-[kind=note]:italic" data-kind={line.kind} role="row" key={index}>
        <span className="w-[5ch] flex-none px-1.5 text-right text-muted select-none" role="cell" aria-label={line.oldLine ? `Old line ${line.oldLine}` : undefined}>{line.oldLine}</span>
        <span className="w-[5ch] flex-none px-1.5 text-right text-muted select-none" role="cell" aria-label={line.newLine ? `New line ${line.newLine}` : undefined}>{line.newLine}</span>
        <span className="w-[2ch] flex-none text-center select-none" role="cell">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : line.kind === 'note' ? '\\' : ' '}</span>
        <code className="pe-4 whitespace-pre [font:inherit]" role="cell">{line.text || ' '}</code>
      </div>)}
    </div>
  </>;
}

function Section({ section }: { section: GitSection }) {
  const metadata = section.id === 'untracked' ? [] : section.metadata;
  return <section className="border-0 [&+section]:border-t [&+section]:border-solid [&+section]:border-border" aria-label={section.label}>
      {metadata.length > 0 && <div className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">{metadata.map((text, index) => <div key={index}>{text}</div>)}</div>}
      {section.binary ? <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">Binary file changed. Text diff is unavailable.</p>
        : section.tooLarge ? <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">This diff exceeds the 2 MB preview limit. View it with a local Git client.</p>
        : !section.hunks.length ? <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">No text changes.</p>
        : section.hunks.map((hunk, index) => <Hunk key={`${index}:${hunk.header}`} hunk={hunk} />)}
  </section>;
}

interface GitDiffViewProps {
  path: string;
  scope: string;
  active: boolean;
  revision: number;
  onOpen?: () => void;
  onClose(): void;
}

export default function GitDiffView({ path, scope, active, revision, onOpen, onClose }: GitDiffViewProps) {
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [error, setError] = useState('');
  const [stuck, setStuck] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
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
    getGitDiff(apiBase, path, scope, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) { setData(value); setError(''); }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [path, scope, active, revision]);
  const label = sections.some(section => section.id === 'untracked') ? 'Untracked Changes'
    : scope === 'staged' ? 'Staged Changes' : scope === 'conflict' ? 'Merge Changes' : 'Unstaged Changes';
  return <div className="content-panel ui-panel">
    <div className="pointer-events-none h-px flex-none -mb-px" ref={sentinelRef} aria-hidden="true" />
    <div className="ui-toolbar items-center gap-1 [&>button]:flex-none">
      <strong className="me-1">{label}</strong>
      {data && <>
        <span className="rounded-full bg-[var(--bgColor-neutral-muted)] px-1.5 py-0.5 text-ui! leading-none font-semibold text-success"
          aria-label={`${sections.reduce((total, section) => total + section.additions, 0)} added lines`}>+{sections.reduce((total, section) => total + section.additions, 0)}</span>
        <span className="rounded-full bg-[var(--bgColor-neutral-muted)] px-1.5 py-0.5 text-ui! leading-none font-semibold text-danger"
          aria-label={`${sections.reduce((total, section) => total + section.deletions, 0)} deleted lines`}>−{sections.reduce((total, section) => total + section.deletions, 0)}</span>
      </>}
      <span className="flex-1" />
      {stuck && <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
        onClick={() => sentinelRef.current?.closest('.main-panel')?.scrollTo({ top: 0, behavior: 'instant' })} />}
      {onOpen && <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={ArrowUpRightIcon} aria-label="Open file" onClick={onOpen} />}
      <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={XIcon} aria-label="Close diff" onClick={onClose} />
    </div>
    {error && <Banner variant="critical" layout="compact" title="Could not load diff" description={error} />}
    {!data && !error && <div className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]" role="status"><Spinner size="small" /> Loading diff…</div>}
    {data?.originalPath && <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">{data.originalPath} → {path}</p>}
    {data?.conflict && <Banner variant="warning" layout="compact" title="Unresolved conflict"
      description="The working file is compared with our side of the merge." />}
    {data?.clean && <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">This file no longer has changes in {label}.</p>}
    {sections.map(section => <Section key={section.id} section={section} />)}
  </div>;
}
