import React, { useEffect, useState } from 'react';
import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { ArrowUpIcon, FocusCenterIcon, KebabHorizontalIcon } from '@primer/octicons-react';
import { BookmarkMenu } from './bookmarks.jsx';
import { apiBase, fileUrl } from './urls.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';
import { formatModified, formatRelativeModified } from './time-labels.mjs';
import styles from './document-toolbar.module.css';

function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function DocumentToolbar({ document, status, stuck, readerRef, sentinelRef, bookmarkState, sidebarToggle }) {
  const [copiedAction, setCopiedAction] = useState('');
  const [copyError, setCopyError] = useState('');
  useEffect(() => {
    if (!copiedAction) return;
    const timer = setTimeout(() => setCopiedAction(''), 1400);
    return () => clearTimeout(timer);
  }, [copiedAction]);
  async function copyValue(label, value) {
    try {
      if (typeof value !== 'string' || !value) throw new Error('Path is unavailable. Reload the page and try again.');
      await navigator.clipboard.writeText(value);
      setCopiedAction(label);
      setCopyError('');
    } catch (cause) {
      setCopyError(`Could not copy ${label.toLowerCase()}: ${cause.message || cause}`);
    }
  }
  return <>
    {copyError && <div className="action-error" role="alert">{copyError}</div>}
    <div className={styles.sentinel} ref={sentinelRef} aria-hidden="true" />
    <div className={['file-toolbar', styles.toolbar].join(' ')} data-paged={status.view === 'preview' && hasDocumentViewport(document)}>
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
            <ActionList.Item onSelect={() => copyValue('path', document.path)}>
              Copy path{copiedAction === 'path' ? ' · Copied' : ''}
            </ActionList.Item>
            <ActionList.Item onSelect={() => copyValue('absolute path', document.absolutePath)}>
              Copy absolute path{copiedAction === 'absolute path' ? ' · Copied' : ''}
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>

      </div>
    </div>
  </>;
}
