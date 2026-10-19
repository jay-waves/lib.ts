import type { Dispatch, SetStateAction, MouseEvent, KeyboardEvent, ReactNode } from 'react';
import { TreeView } from '@primer/react';
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
  variant?: 'sidebar' | 'results';
  navigateDirectories?: boolean;
  expandedPaths: Record<string, boolean>;
  setExpandedPaths: Dispatch<SetStateAction<Record<string, boolean>>>;
}

// SubTree mounts its children only when expanded. Defer recursion until then,
// rather than allocating React elements for every descendant of a closed folder.
function TreeChildren({ nodes, renderNode }: { nodes: FileTreeNode[]; renderNode(node: FileTreeNode): ReactNode }) {
  return nodes.map(renderNode);
}

export function FileTree({ nodes, label, selected, navigate, searching = false, variant = 'sidebar', navigateDirectories = true, expandedPaths, setExpandedPaths }: FileTreeProps) {
  function renderNode(node: FileTreeNode) {
    const directory = node.type === 'directory';
    const expanded = expandedPaths[node.path] ?? (node.virtual || searching);
    function activate(event: MouseEvent | KeyboardEvent) {
      if (!isPlainTreeActivation(event)) return;
      event.preventDefault();
      if (node.virtual || (directory && (!navigateDirectories || !expanded))) {
        setExpandedPaths(paths => ({ ...paths, [node.path]: !expanded }));
        return;
      }
      navigate(node.path, directory);
    }
    const link = <a className="file-tree-link" href={fileUrl(node.path, directory)} tabIndex={-1}
      aria-current={node.path === selected && !directory ? 'page' : undefined}>{node.name}</a>;
    return (
      <TreeView.Item key={node.path} className="file-tree-item" id={node.path} current={node.path === selected}
        expanded={directory ? expanded : undefined}
        onExpandedChange={directory ? expanded => setExpandedPaths(paths => ({ ...paths, [node.path]: expanded })) : undefined}
        onSelect={activate}>
        <TreeView.LeadingVisual><span className="inline-flex [&_svg]:size-3.5!">{directory ? <TreeView.DirectoryIcon /> : <FileTypeIcon name={node.name} />}</span></TreeView.LeadingVisual>
        {node.virtual || (directory && !navigateDirectories) ? <span className="file-tree-link">{node.name}</span> : link}
        {directory && <TreeView.SubTree>{node.children?.length ? <TreeChildren nodes={node.children} renderNode={renderNode} /> : null}</TreeView.SubTree>}
      </TreeView.Item>
    );
  }
  return <div className={`file-tree-view${variant === 'results' ? ' search-file-tree' : ''}`}><TreeView aria-label={label}>{nodes.map(renderNode)}</TreeView></div>;
}
