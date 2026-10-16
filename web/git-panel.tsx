import { ActionList, Banner, CounterLabel, Spinner } from '@primer/react';
import { ChevronRightIcon, GitBranchIcon, FileDiffIcon } from '@primer/octicons-react';
import { groupGitChanges } from './git-changes.ts';
import './git-panel.css';
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
  return <div className="git-panel">
    <div className="git-panel-heading">
      <GitBranchIcon />
      <span className="git-panel-branch" title={status?.branch}>{status?.repository ? status.branch : 'Git'}</span>
    </div>
    {loading && !status && <div className="tree-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading Git status</span></div>}
    {error && <Banner variant="critical" layout="compact" title="Git refresh failed" description={error} />}
    {empty && <div className="tree-empty">{empty}</div>}
    {groups.length > 0 && <div className="tree-scroll">
      {groups.map(group => <details key={group.id} className="git-change-group" open>
        <summary className="git-group-summary">
          <ChevronRightIcon /> {group.label} <CounterLabel>{group.changes.length}</CounterLabel>
        </summary>
        <ActionList variant="full" aria-label={group.label}>{group.changes.map(change => {
          const label = changeLabel(change.code);
          return <ActionList.Item className="sidebar-list-item" key={change.path} active={selected === change.path && scope === group.id}
            onSelect={() => onSelect(change.path, group.id)}>
            <ActionList.LeadingVisual><FileDiffIcon /></ActionList.LeadingVisual>
            <span className="sidebar-path git-change-path" title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}><bdi dir="ltr">{change.path}</bdi></span>
            <ActionList.TrailingVisual>
              <span className="git-change-status" data-kind={label} title={label} aria-label={label}>{change.code}</span>
            </ActionList.TrailingVisual>
          </ActionList.Item>;
        })}</ActionList>
      </details>)}
    </div>}
  </div>;
}
