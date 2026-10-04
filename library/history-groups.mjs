import { fileListFromPaths } from './file-tree.mjs';
import { HISTORY_GROUPS, historyTimeGroup } from './time-labels.mjs';

export function historyFileGroups(paths = [], visitedAt = {}, now = Date.now()) {
  const groups = new Map(HISTORY_GROUPS.map(group => [group.id,
    { name: group.name, path: `history:${group.id}`, type: 'directory', virtual: true, children: [] }]));
  for (const node of fileListFromPaths(paths)) groups.get(historyTimeGroup(visitedAt[node.path], now))?.children.push(node);
  return [...groups.values()].filter(group => group.children.length);
}
