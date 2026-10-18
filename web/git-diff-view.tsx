import { IconButton } from '@primer/react';
import React, { useEffect, useId, useState } from 'react';
import { Banner, Spinner } from '@primer/react';
import { ArrowUpRightIcon, FoldIcon, UnfoldIcon, XIcon } from '@primer/octicons-react';
import { FileToolbar, MoveToTopButton, useToolbarStuck } from './file-toolbar';
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
      {expanded && hunk.lines.map((line, index) => <div className="group flex min-w-full w-max data-[kind=add]:bg-[var(--git-added-bg)] data-[kind=delete]:bg-[var(--git-deleted-bg)] data-[kind=note]:text-muted data-[kind=note]:italic" data-kind={line.kind} role="row" key={index}>
        <span className="w-[5ch] flex-none px-1.5 text-right text-muted select-none" role="cell" aria-label={line.oldLine ? `Old line ${line.oldLine}` : undefined}>{line.oldLine}</span>
        <span className="w-[5ch] flex-none px-1.5 text-right text-muted select-none" role="cell" aria-label={line.newLine ? `New line ${line.newLine}` : undefined}>{line.newLine}</span>
        <span className="w-[2ch] flex-none text-center select-none group-data-[kind=add]:text-[var(--git-added-fg)] group-data-[kind=delete]:text-[var(--git-deleted-fg)]" role="cell">{line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : line.kind === 'note' ? '\\' : ' '}</span>
        <code className="pe-4 whitespace-pre [font:inherit]" role="cell">{line.text || ' '}</code>
      </div>)}
    </div>
  </>;
}

function Section({ section }: { section: GitSection }) {
  return <section className="border-0 [&+section]:border-t [&+section]:border-solid [&+section]:border-border" aria-label={section.label}>
      {section.binary ? <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">Binary file changed. Text diff is unavailable.</p>
        : section.tooLarge ? <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">This diff exceeds the 2 MB preview limit. View it with a local Git client.</p>
        : !section.hunks.length ? section.metadata.length ? null : <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">No text changes.</p>
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
  const { stuck, sentinelRef } = useToolbarStuck(active);
  const sections = data?.sections || [];
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
  const additions = sections.reduce((total, section) => total + section.additions, 0);
  const deletions = sections.reduce((total, section) => total + section.deletions, 0);
  const metadata = sections.filter(section => section.id !== 'untracked').flatMap(section => section.metadata);
  const deleted = metadata.some(text => text.startsWith('deleted file mode '));
  const renamedFrom = data?.originalPath || metadata.find(text => text.startsWith('rename from '))?.slice(12);
  const renamedTo = metadata.find(text => text.startsWith('rename to '))?.slice(10) || path;
  const details = [...new Set(metadata.filter(text => !/^(rename from |rename to |similarity index |deleted file mode )/.test(text)))];
  return <div className="content-panel ui-panel">
    <FileToolbar sentinelRef={sentinelRef} className="items-center gap-1 [&>button]:flex-none">
      <strong className="me-1 flex-none">{label}</strong>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1">
      {renamedFrom && <span className="min-w-0 text-muted [overflow-wrap:anywhere]">{renamedFrom} → {renamedTo}</span>}
      {deleted && <span className="text-muted">deleted</span>}
      {details.map(text => <span key={text} className="min-w-0 text-muted [overflow-wrap:anywhere]">{text}</span>)}
      {data && ((!renamedFrom && !deleted) || additions > 0 || deletions > 0) && <>
        <span className="text-ui! leading-none font-semibold text-[var(--git-added-fg)]"
          aria-label={`${additions} added lines`}>+{additions}</span>
        <span className="text-ui! leading-none font-semibold text-[var(--git-deleted-fg)]"
          aria-label={`${deletions} deleted lines`}>−{deletions}</span>
      </>}
      </div>
      {stuck && <MoveToTopButton />}
      {onOpen && <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={ArrowUpRightIcon} aria-label="Open file" onClick={onOpen} />}
      <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={XIcon} aria-label="Close diff" onClick={onClose} />
    </FileToolbar>
    {error && <Banner variant="critical" layout="compact" title="Could not load diff" description={error} />}
    {!data && !error && <div className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]" role="status"><Spinner size="small" /> Loading diff…</div>}
    {data?.conflict && <Banner variant="warning" layout="compact" title="Unresolved conflict"
      description="The working file is compared with our side of the merge." />}
    {data?.clean && <p className="m-0 px-3.5 py-3 text-ui text-muted [overflow-wrap:anywhere]">This file no longer has changes in {label}.</p>}
    {sections.map(section => <Section key={section.id} section={section} />)}
  </div>;
}
