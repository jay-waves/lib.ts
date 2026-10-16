import { IconButton } from '@primer/react';
import { useActionState } from 'react';

import { CopyIcon, FileDirectoryOpenFillIcon, FileDirectoryIcon, FileIcon, MarkdownIcon } from '@primer/octicons-react';
import { apiBase, fileUrl } from './urls.mjs';
import { formatRelativeModified } from './time-labels.mjs';
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
  return <div>
    <div className="flex min-h-toolbar box-border items-center justify-between gap-3 border-0 border-b border-solid border-border bg-subtle px-3.5 text-meta text-muted @max-reader-md/reader:ps-3 @max-reader-md/reader:pe-2">
      <span>{directory.children.length} items</span>
      <form action={open} className="flex flex-none items-center gap-1" aria-label="Directory actions">
        <IconButton unsafeDisableTooltip type="submit" size="small" variant="invisible" icon={FileDirectoryOpenFillIcon}
          aria-label="Open in Explorer" disabled={opening} />
        <IconButton unsafeDisableTooltip type="button" size="small" variant="invisible" icon={CopyIcon}
          aria-label={copied ? 'Absolute path copied' : 'Copy absolute path'} onClick={() => copy('absolute path', directory.absolutePath)} />
      </form>
    </div>
    {(openError || copyError) && <div className="action-error" role="alert">{openError || copyError}</div>}
    {directory.children.map(node => <a className="ui-focus flex min-h-toolbar box-border items-center gap-2 border-0 border-b border-solid border-divider px-3.5 py-2 text-ui text-fg no-underline last:border-b-0 hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted @max-reader-md/reader:px-3 @max-reader-sm/reader:flex-wrap" key={node.path} href={fileUrl(node.path, node.type === 'directory')}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(node.path, node.type === 'directory');
      }}>
      {node.type === 'directory' ? <FileDirectoryIcon /> : node.name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />}
      <span className="min-w-0 truncate @max-reader-sm/reader:flex-1">{node.name}</span>
      {node.type === 'directory' && node.modified && <time className="ms-auto flex-none whitespace-nowrap text-meta text-muted @max-reader-sm/reader:ms-6 @max-reader-sm/reader:w-[calc(100%-24px)]" dateTime={node.modified}
        >{formatRelativeModified(node.modified)}</time>}
    </a>)}
  </div>;
}
