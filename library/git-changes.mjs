export const isGitConflict = status => status.includes('U') || status === 'AA' || status === 'DD';

// A partially staged file belongs to both groups, with a different status in each.
export function groupGitChanges(changes) {
  const groups = [
    { id: 'conflict', label: 'Merge Changes', changes: [] },
    { id: 'staged', label: 'Staged Changes', changes: [] },
    { id: 'unstaged', label: 'Changes', changes: [] },
  ];
  for (const change of changes) {
    if (isGitConflict(change.status)) groups[0].changes.push({ ...change, code: 'U' });
    else if (change.status === '??') groups[2].changes.push({ ...change, code: '?' });
    else {
      if (change.status[0] !== '.') groups[1].changes.push({ ...change, code: change.status[0] });
      if (change.status[1] !== '.') groups[2].changes.push({ ...change, code: change.status[1] });
    }
  }
  return groups.filter(group => group.changes.length);
}
