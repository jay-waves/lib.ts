import type { Dispatch, SetStateAction } from 'react';
import { TreeView } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { PinIcon, XIcon, MarkdownIcon, FileIcon } from '@primer/octicons-react';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';
import type { TreeNode } from './api/contracts';
import type { BookmarkState } from './bookmarks';

export interface FileTreeNode extends Pick<TreeNode, 'name' | 'path' | 'type'> {
  virtual?: boolean;
  children?: FileTreeNode[];
}

interface FileTreeProps {
  nodes: FileTreeNode[];
  label: string;
  selected: string;
  navigate(path: string, directory: boolean): void;
  searching?: boolean;
  expandedPaths: Record<string, boolean>;
  setExpandedPaths: Dispatch<SetStateAction<Record<string, boolean>>>;
  bookmarkState?: BookmarkState;
  defaultExpanded?: boolean;
}

function fileIcon(name: string) { return name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />; }

export function FileTree({ nodes, label, selected, navigate, searching = false, expandedPaths, setExpandedPaths, bookmarkState, defaultExpanded = false }: FileTreeProps) {
  const bookmarked = new Set(bookmarkState?.bookmarks.map(item => item.path));
  function renderNode(node: FileTreeNode) {
    const directory = node.type === 'directory';
    const pinned = bookmarked.has(node.path);
    const expanded = expandedPaths[node.path] ?? (node.virtual || defaultExpanded);
    const link = <a className="file-tree-link" href={fileUrl(node.path, directory)} tabIndex={-1}
      aria-current={node.path === selected && !directory ? 'page' : undefined} title={directory ? node.path : undefined}>{node.name}</a>;
    return (
      <TreeView.Item key={node.path} className="file-tree-item" id={node.path} current={node.path === selected}
        secondaryActions={!directory && bookmarkState ? [{
          label: pinned ? 'Remove bookmark' : 'Add bookmark',
          icon: pinned ? XIcon : PinIcon,
          onClick: () => { if (!bookmarkState.loading && !bookmarkState.saving) void bookmarkState.setBookmark(node.path, !pinned); },
        }] : undefined}
        expanded={directory ? expanded || (!node.virtual && searching) : undefined}
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
        {node.virtual ? <span className="file-tree-link">{node.name}</span> : directory ? link
          : <Tooltip text={node.path} type="description" direction="s">{link}</Tooltip>}
        {directory && <TreeView.SubTree>{node.children?.map(renderNode)}</TreeView.SubTree>}
      </TreeView.Item>
    );
  }
  return <TreeView aria-label={label}>{nodes.map(renderNode)}</TreeView>;
}
