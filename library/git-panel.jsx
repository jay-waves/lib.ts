import React from 'react';
import { ActionList, Banner, Button, CounterLabel, Details, Spinner, useDetails } from '@primer/react';
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, FileDiffIcon } from '@primer/octicons-react';
import { groupGitChanges } from './git-changes.mjs';
import './git-panel.css';

function changeLabel(status) {
  if (status === '?') return 'Untracked';
  if (status.includes('U') || status === 'AA' || status === 'DD') return 'Conflict';
  if (status.includes('D')) return 'Deleted';
  if (status.includes('R')) return 'Renamed';
  if (status.includes('A')) return 'Added';
  if (status.includes('C')) return 'Copied';
  return 'Modified';
}

function ChangeGroup({ group, selected, scope, onSelect }) {
  const { open, getDetailsProps } = useDetails({ defaultOpen: true, closeOnOutsideClick: false });
  return <Details {...getDetailsProps()}>
    <Button as="summary" block variant="invisible" size="small" alignContent="start" className="git-group-summary"
      leadingVisual={open ? ChevronDownIcon : ChevronRightIcon}>
      {group.label} <CounterLabel>{group.changes.length}</CounterLabel>
    </Button>
    {open && <ActionList aria-label={group.label}>{group.changes.map(change => <ActionList.Item key={change.path}
      active={selected === change.path && scope === group.id} onSelect={() => onSelect(change.path, group.id)}>
      <ActionList.LeadingVisual><FileDiffIcon /></ActionList.LeadingVisual>
      <span className="git-change-path" title={change.originalPath ? `${change.originalPath} → ${change.path}` : change.path}>{change.path}</span>
      <ActionList.TrailingVisual><span className="git-change-status" data-kind={changeLabel(change.code)}
        title={changeLabel(change.code)} aria-label={changeLabel(change.code)}>{change.code}</span></ActionList.TrailingVisual>
    </ActionList.Item>)}</ActionList>}
  </Details>;
}

export default function GitPanel({ onSelect, selected, scope, state: { status, loading, error } }) {
  return <div className="git-panel">
    <div className="git-panel-heading">
      <GitBranchIcon />
      <span className="git-panel-branch" title={status?.branch}>{status?.repository ? status.branch : 'Git'}</span>
    </div>
    {loading && !status && <div className="tree-loading" role="status"><Spinner size="small" /><span className="visually-hidden">Loading Git status</span></div>}
    {error && <Banner variant="critical" layout="compact" title="Git refresh failed" description={error} />}
    {status && <>
      {!status.repository ? <div className="tree-empty">This directory is not a Git repository.</div>
        : !status.changes.length ? <div className="tree-empty">Working tree clean</div>
          : <div className="tree-scroll">
            {groupGitChanges(status.changes).map(group => <ChangeGroup key={group.id} group={group}
              selected={selected} scope={scope} onSelect={onSelect} />)}
          </div>}
    </>}
  </div>;
}
