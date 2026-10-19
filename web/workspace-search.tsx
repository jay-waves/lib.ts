import React, { useMemo } from 'react';
import { ActionList } from '@primer/react';
import { BookmarkIcon, CheckIcon, FileDirectoryIcon, NoteIcon, ListUnorderedIcon } from '@primer/octicons-react';
import { useCodeSearch } from './code-search';

import type { CodeSearchOptions } from './code-search';
import type { TreeNode, Bookmark } from './api/contracts';

type WorkspaceSearchOptions = Omit<CodeSearchOptions, 'scopeFilter' | 'paths' | 'pathSuggestions'> & {
  treeIndex: ReadonlyMap<string, TreeNode>; bookmarks: readonly Bookmark[];
};

const scopes = [
  { value: 'current-file', label: 'Current File', icon: NoteIcon },
  { value: 'files', label: 'Files', icon: FileDirectoryIcon },
  { value: 'bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
  { value: 'symbols', label: 'Symbols', icon: ListUnorderedIcon },
] as const;

export function useWorkspaceSearch({ config, onConfig, navigate, active, currentFile, scrollRef, treeIndex, bookmarks, symbols, onSelectSymbol }: WorkspaceSearchOptions) {
  const scope = config.scope || '';
  const scopeFilter = <>
      <section className="search-facet">
        <h2 className="search-facet-title">Scope</h2>
        <ActionList variant="full" role="listbox" aria-label="Search scope" aria-multiselectable={false}>
          {scopes.map(item => <ActionList.Item className="sidebar-list-item group" key={item.value} role="option"
            disabled={item.value === 'current-file' && treeIndex.get(currentFile)?.type !== 'file'}
            active={scope === item.value} aria-selected={scope === item.value}
            onSelect={() => onConfig({ ...config, scope: scope === item.value ? '' : item.value })}>
            <ActionList.LeadingVisual>
              <span className="flex size-4 items-center justify-center [&>svg]:block [&>svg]:shrink-0">{React.createElement(item.icon, { size: 16 })}</span>
            </ActionList.LeadingVisual>
            <span className="search-facet-label">{item.label}</span>
            {scope === item.value && <ActionList.TrailingVisual><CheckIcon /></ActionList.TrailingVisual>}
          </ActionList.Item>)}
        </ActionList>
      </section>
    </>;
  const paths = useMemo(() => scope === 'bookmarks' ? bookmarks.map(item => item.path)
    : scope === 'files' ? [...treeIndex.values()].filter(node => node.type === 'file').map(node => node.path) : [], [scope, bookmarks, treeIndex]);
  const pathSuggestions = useMemo(() => [...treeIndex.values()].filter(node => node.type === 'directory')
    .map(node => ({ value: `${node.path.replace(/\/+$/, '')}/` }))
    .sort((a, b) => a.value.localeCompare(b.value)), [treeIndex]);
  return useCodeSearch({ config: { ...config, scope }, onConfig, navigate, active, currentFile, scrollRef, scopeFilter,
    paths, pathSuggestions, symbols, onSelectSymbol });
}
