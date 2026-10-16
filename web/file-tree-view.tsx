import type { Dispatch, SetStateAction, MouseEvent, KeyboardEvent } from 'react';
import { TreeView } from '@primer/react';
import { Tooltip } from '@primer/react/next';
import { FileTypeIcon } from './file-type-icon';
import { fileUrl } from './urls.mjs';
import { isPlainTreeActivation } from './file-tree.mjs';
import type { TreeNode } from './api/contracts';

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
}

export function FileTree({ nodes, label, selected, navigate, searching = false, expandedPaths, setExpandedPaths }: FileTreeProps) {
  function renderNode(node: FileTreeNode) {
    const directory = node.type === 'directory';
    const expanded = expandedPaths[node.path] ?? (node.virtual || searching);
    function activate(event: MouseEvent | KeyboardEvent) {
      if (!isPlainTreeActivation(event)) return;
      event.preventDefault();
      if (node.virtual || (directory && !expanded)) {
        setExpandedPaths(paths => ({ ...paths, [node.path]: !expanded }));
        return;
      }
      navigate(node.path, directory);
    }
    const link = <a className="file-tree-link" href={fileUrl(node.path, directory)} tabIndex={-1}
      aria-current={node.path === selected && !directory ? 'page' : undefined} title={directory ? node.path : undefined}>{node.name}</a>;
    return (
      <TreeView.Item key={node.path} className="file-tree-item" id={node.path} current={node.path === selected}
        expanded={directory ? expanded : undefined}
        onExpandedChange={directory ? expanded => setExpandedPaths(paths => ({ ...paths, [node.path]: expanded })) : undefined}
        onSelect={activate}>
        <TreeView.LeadingVisual>{directory ? <TreeView.DirectoryIcon /> : <FileTypeIcon name={node.name} />}</TreeView.LeadingVisual>
        {node.virtual ? <span className="file-tree-link">{node.name}</span> : directory ? link
          : <Tooltip text={node.path} type="description" direction="s">{link}</Tooltip>}
        {directory && <TreeView.SubTree>{node.children?.map(renderNode)}</TreeView.SubTree>}
      </TreeView.Item>
    );
  }
  return <TreeView aria-label={label}>{nodes.map(renderNode)}</TreeView>;
}
