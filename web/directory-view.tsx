import { useActionState } from 'react';
import { IconButton } from '@primer/react';
import { CopyIcon, FileDirectoryOpenFillIcon, FileDirectoryIcon, FileIcon, MarkdownIcon } from '@primer/octicons-react';
import { apiBase, fileUrl } from './urls.mjs';
import { formatModified, formatRelativeModified } from './time-labels.mjs';
import styles from './directory-view.module.css';
import type { TreeNode } from './api/contracts';
import { openDirectory } from './api/library';
import { useClipboard } from './use-clipboard';

interface DirectoryViewProps {
  directory: { path?: string; absolutePath?: string; children: TreeNode[] };
  navigate(path: string, directory: boolean): void;
}

export function DirectoryView({ directory, navigate }: DirectoryViewProps) {
  const { copied, error: copyError, copy } = useClipboard();
  const [openError, open, opening] = useActionState(async () => {
    try {
      await openDirectory(apiBase, directory.path);
      return '';
    } catch (error) { return `Could not open directory: ${error instanceof Error ? error.message : String(error)}`; }
  }, '');
  return <div className={styles.list}>
    <div className={styles.heading}>
      <span>{directory.children.length} items</span>
      <form action={open} className={styles.actions} aria-label="Directory actions">
        <IconButton type="submit" size="small" variant="invisible" icon={FileDirectoryOpenFillIcon}
          aria-label="Open in Explorer" title="Open in Explorer" disabled={opening} />
        <IconButton type="button" size="small" variant="invisible" icon={CopyIcon}
          aria-label={copied ? 'Absolute path copied' : 'Copy absolute path'}
          title={copied ? 'Absolute path copied' : 'Copy absolute path'} onClick={() => copy('absolute path', directory.absolutePath)} />
      </form>
    </div>
    {(openError || copyError) && <div className="action-error" role="alert">{openError || copyError}</div>}
    {directory.children.map(node => <a key={node.path} href={fileUrl(node.path, node.type === 'directory')}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(node.path, node.type === 'directory');
      }}>
      {node.type === 'directory' ? <FileDirectoryIcon /> : node.name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />}
      <span title={node.name}>{node.name}</span>
      {node.type === 'directory' && node.modified && <time className={styles.modified} dateTime={node.modified}
        title={formatModified(node.modified)}>{formatRelativeModified(node.modified)}</time>}
    </a>)}
  </div>;
}
