import React from 'react';
import { ActionList } from '@primer/react';
import { BookmarkIcon, CheckIcon, FileDirectoryIcon, NoteIcon, ListUnorderedIcon } from '@primer/octicons-react';
import { useCodeSearch } from './code-search.jsx';

const scopes = [
  { value: 'current-file', label: 'Current File', icon: NoteIcon },
  { value: 'files', label: 'Files', icon: FileDirectoryIcon },
  { value: 'bookmarks', label: 'Bookmarks', icon: BookmarkIcon },
  { value: 'symbols', label: 'Symbols', icon: ListUnorderedIcon },
];

export function useWorkspaceSearch({ config, onConfig, navigate, active, currentFile, scrollRef, treeIndex, bookmarks, symbols, onSelectSymbol }) {
  const scope = config.scope || '';
  const scopeFilter = <>
      <section className="search-facet search-scope-picker">
        <h2>Scope</h2>
        <ActionList role="listbox" aria-label="Search scope" aria-multiselectable={false}>
          {scopes.map(item => <ActionList.Item key={item.value} role="option"
            disabled={item.value === 'current-file' && treeIndex.get(currentFile)?.type !== 'file'}
            active={scope === item.value} aria-selected={scope === item.value}
            onSelect={() => onConfig({ ...config, scope: scope === item.value ? '' : item.value })}>
            <ActionList.LeadingVisual>
              <span className="search-scope-icon">{React.createElement(item.icon, { size: 16 })}</span>
            </ActionList.LeadingVisual>
            <span className="search-facet-value">{item.label}</span>
            {scope === item.value && <ActionList.TrailingVisual><CheckIcon /></ActionList.TrailingVisual>}
          </ActionList.Item>)}
        </ActionList>
      </section>
    </>;
  const paths = scope === 'files' ? [...treeIndex.values()].filter(node => node.type === 'file').map(node => node.path)
    : scope === 'bookmarks' ? bookmarks.map(item => item.path) : [];
  const pathSuggestions = [...treeIndex.values()].filter(node => node.type === 'directory')
    .map(node => ({ value: `${node.path.replace(/\/+$/, '')}/` }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return useCodeSearch({ config: { ...config, scope }, onConfig, navigate, active, currentFile, scrollRef, scopeFilter,
    paths, pathSuggestions, symbols, onSelectSymbol });
}
