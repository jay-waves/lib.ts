import React from 'react';
import { TreeView } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { PinIcon, XIcon, MarkdownIcon, FileIcon } from '@primer/octicons-react';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';

function fileIcon(name) { return name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />; }

export function FileTree({ nodes, label, selected, navigate, searching = false, expandedPaths, setExpandedPaths, bookmarkState, defaultExpanded = false }) {
  const bookmarked = new Set(bookmarkState?.bookmarks.map(item => item.path));
  function renderNode(node) {
    const directory = node.type === 'directory';
    return (
      <TreeView.Item key={node.path} className="file-tree-item" id={node.path} current={node.path === selected}
        secondaryActions={!directory && bookmarkState ? [{
          label: bookmarked.has(node.path) ? 'Remove bookmark' : 'Add bookmark',
          icon: bookmarked.has(node.path) ? XIcon : PinIcon,
          onClick: () => { if (!bookmarkState.loading && !bookmarkState.saving) void bookmarkState.setBookmark(node.path,
            !bookmarked.has(node.path)); },
        }] : undefined}
        expanded={directory ? (node.virtual ? expandedPaths[node.path] ?? true : searching || (expandedPaths[node.path] ?? defaultExpanded)) : undefined}
        onExpandedChange={directory ? expanded => setExpandedPaths(paths => ({ ...paths, [node.path]: expanded })) : undefined}
        onSelect={event => {
          if (!isPlainTreeActivation(event)) return;
          event.preventDefault();
          if (node.virtual) {
            setExpandedPaths(paths => ({ ...paths, [node.path]: !(paths[node.path] ?? true) }));
            return;
          }
          navigate(node.path, directory);
        }}>
        <TreeView.LeadingVisual>{directory ? <TreeView.DirectoryIcon /> : fileIcon(node.name)}</TreeView.LeadingVisual>
        {node.virtual ? <span className="file-tree-link">{node.name}</span> : !directory ? <Tooltip text={node.path} type="description" direction="s">
          <a className="file-tree-link" aria-current={node.path === selected ? 'page' : undefined} href={fileUrl(node.path)} tabIndex={-1}>{node.name}</a>
        </Tooltip> : <a className="file-tree-link" href={fileUrl(node.path, directory)} title={node.path} tabIndex={-1}>{node.name}</a>}
        {directory && <TreeView.SubTree>{node.children.map(renderNode)}</TreeView.SubTree>}
      </TreeView.Item>
    );
  }
  return <TreeView aria-label={label}>{nodes.map(renderNode)}</TreeView>;
}
