import type { ReactNode, Ref, RefObject } from 'react';
import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { ArrowUpIcon, FocusCenterIcon, KebabHorizontalIcon } from '@primer/octicons-react';
import { BookmarkMenu } from './bookmarks';
import { apiBase, fileUrl } from './urls.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';
import { formatModified, formatRelativeModified } from './time-labels.mjs';
import styles from './document-toolbar.module.css';
import type { BookmarkState } from './bookmarks';
import { useClipboard } from './use-clipboard';

interface DocumentToolbarProps {
  document: {
    path: string;
    absolutePath?: string;
    type: string;
    size: number;
    modified?: string;
    lineCount?: number | null;
  };
  status: { view: 'preview' | 'raw'; line?: number | null; pending?: boolean };
  stuck: boolean;
  readerRef: RefObject<{
    switchView(view: 'preview' | 'raw'): void;
    toTop(): void;
    fit(): void;
  } | null>;
  sentinelRef: Ref<HTMLDivElement>;
  bookmarkState: BookmarkState;
  sidebarToggle?: ReactNode;
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function DocumentToolbar({ document, status, stuck, readerRef, sentinelRef, bookmarkState, sidebarToggle }: DocumentToolbarProps) {
  const { copied, error, copy } = useClipboard();
  return <>
    {error && <div className="action-error" role="alert">{error}</div>}
    <div className={styles.sentinel} ref={sentinelRef} aria-hidden="true" />
    <div className={`file-toolbar ${styles.toolbar}`}>
      <div className={styles.tabs} role="tablist" aria-label="File view">
        {document.type !== 'text' && <button className={styles.tab} role="tab"
          aria-selected={status.view === 'preview'} onClick={() => readerRef.current?.switchView('preview')}>Preview</button>}
        {!['image', 'pdf', 'binary'].includes(document.type) && <button className={styles.tab} role="tab"
          aria-selected={status.view === 'raw'} onClick={() => readerRef.current?.switchView('raw')}>Raw</button>}
      </div>
      <span className={styles.position} aria-busy={document.lineCount != null && status.pending}>
        {document.lineCount != null && <>{`${status.line ?? '—'} / ${document.lineCount} lines · `}</>}
        {sizeLabel(document.size)}
        {document.modified && <>{' · '}<time dateTime={document.modified} title={formatModified(document.modified)}>
          {formatRelativeModified(document.modified)}
        </time></>}
      </span>
      <div className={styles.actions} role="group" aria-label="Page actions">
        {stuck && <IconButton size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top"
          title="Back to top" onClick={() => readerRef.current?.toTop()} />}
        {stuck && status.view === 'preview' && hasDocumentViewport(document) && <IconButton
          size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Fit and recenter page"
          title="Fit and recenter page" onClick={() => readerRef.current?.fit()} />}
        {sidebarToggle}
      <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton size="small" variant="invisible" className={styles.menu} icon={KebabHorizontalIcon}
            aria-label="Menu" title="Menu" />
        </ActionMenu.Anchor>
        <ActionMenu.Overlay>
          <ActionList>
            <BookmarkMenu state={bookmarkState} path={document.path} />
            <ActionList.LinkItem href={fileUrl(document.path)} target="_blank" rel="noopener noreferrer">
              Open in New Tab
            </ActionList.LinkItem>
            <ActionList.LinkItem href={`${apiBase}/asset?path=${encodeURIComponent(document.path)}`}
              target="_blank" rel="noopener noreferrer">
              Open raw file
            </ActionList.LinkItem>
            <ActionList.Item onSelect={() => copy('path', document.path)}>
              Copy path{copied === 'path' ? ' · Copied' : ''}
            </ActionList.Item>
            <ActionList.Item onSelect={() => copy('absolute path', document.absolutePath)}>
              Copy absolute path{copied === 'absolute path' ? ' · Copied' : ''}
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>

      </div>
    </div>
  </>;
}
