import { ActionList, Banner, CounterLabel, Spinner } from '@primer/react';
import { ChevronRightIcon, FileDiffIcon } from '@primer/octicons-react';
import { groupGitChanges } from './git-changes.ts';
import type { GitState } from './git-resource';

interface GitPanelProps {
  selected: string;
  scope: string;
  onSelect(path: string, scope: string): void;
  state: GitState;
}

function changeLabel(status: string) {
  if (status === '?') return 'Untracked';
  if (status.includes('U') || status === 'AA' || status === 'DD') return 'Conflict';
  if (status.includes('D')) return 'Deleted';
  if (status.includes('R')) return 'Renamed';
  if (status.includes('A')) return 'Added';
  if (status.includes('C')) return 'Copied';
  return 'Modified';
}

export default function GitPanel({ onSelect, selected, scope, state: { status, loading, error } }: GitPanelProps) {
  const groups = groupGitChanges(status?.changes ?? []);
  const empty = status && (!status.repository ? 'This directory is not a Git repository.'
    : !groups.length ? 'Working tree clean' : '');
  return <div className="flex min-h-0 flex-1 flex-col pt-1">
    {loading && !status && <div className="sidebar-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading Git status</span></div>}
    {error && <Banner variant="critical" layout="compact" title="Git refresh failed" description={error} />}
    {empty && <div className="sidebar-empty">{empty}</div>}
    {groups.length > 0 && <div className="sidebar-scroll">
      {groups.map(group => <details key={group.id} className="group" open>
        <summary className="ui-focus mt-1.5 flex cursor-pointer list-none items-center gap-2 rounded-ui px-2 py-1.5 text-ui hover:bg-hover group-first:mt-0 group-open:[&>svg]:rotate-90">
          <ChevronRightIcon /> {group.label} <CounterLabel>{group.changes.length}</CounterLabel>
        </summary>
        <ActionList className="mt-1!" variant="full" aria-label={group.label}>{group.changes.map(change => {
          const label = changeLabel(change.code);
          return <ActionList.Item className="sidebar-list-item" key={change.path} active={selected === change.path && scope === group.id}
            onSelect={() => onSelect(change.path, group.id)}>
            <ActionList.LeadingVisual><FileDiffIcon /></ActionList.LeadingVisual>
            <span className="sidebar-path git-change-path text-ui text-fg"><bdi dir="ltr">{change.path}</bdi></span>
            <ActionList.TrailingVisual>
              <span className="text-meta font-semibold text-attention data-[kind=Added]:text-[var(--git-added-fg)] data-[kind=Untracked]:text-[var(--git-added-fg)] data-[kind=Deleted]:text-[var(--git-deleted-fg)] data-[kind=Conflict]:text-[var(--git-deleted-fg)]" data-kind={label} aria-label={label}>{change.code}</span>
            </ActionList.TrailingVisual>
          </ActionList.Item>;
        })}</ActionList>
      </details>)}
    </div>}
  </div>;
}
