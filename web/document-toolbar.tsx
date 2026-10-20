import { ActionList, ActionMenu, IconButton } from '@primer/react';
import type { ReactNode, Ref } from 'react';
import { FocusCenterIcon, KebabHorizontalIcon } from '@primer/octicons-react';
import { BookmarkMenu } from './bookmarks/bookmarks';
import { apiBase, fileUrl } from './urls.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';
import { DocumentDetails } from './document-details';
import type { DocumentInfo } from './document-info';
import type { BookmarkState } from './bookmarks/bookmarks';
import { useClipboard } from './use-clipboard';
import { FileToolbar, MoveToTopButton } from './file-toolbar';
import { readerViews } from './reader-session.mjs';

interface DocumentToolbarProps {
  info: DocumentInfo;
  loaded: boolean;
  view: 'preview' | 'raw';
  progress?: { line?: number | null; pending?: boolean; bookmarkPage?: import('./api/contracts').Bookmark['page'] };
  dimensions?: { width: number; height: number };
  stuck: boolean;
  actions: {
    switchView(view: 'preview' | 'raw'): void;
    toTop(): void;
    fit(): void;
  };
  sentinelRef: Ref<HTMLDivElement>;
  bookmarkState: BookmarkState;
  sidebarToggle?: ReactNode;
}

export function DocumentToolbar({ info: document, loaded, view, progress, dimensions, stuck, actions, sentinelRef, bookmarkState, sidebarToggle }: DocumentToolbarProps) {
  const { copied, error, copy } = useClipboard();
  return <>
    {error && <div className="action-error" role="alert">{error}</div>}
    <FileToolbar sentinelRef={sentinelRef} className="items-stretch gap-2">
      <div className="-mb-px flex flex-none items-stretch gap-2 @max-reader-sm/reader:mb-0 @max-reader-sm/reader:min-h-8" role="tablist" aria-label="File view">
        {readerViews(document).map(value => <button key={value} className="ui-tab" role="tab" disabled={!loaded}
          aria-selected={view === value} onClick={() => actions.switchView(value)}>{value === 'raw' ? 'Raw' : 'Preview'}</button>)}
      </div>
      <DocumentDetails document={document} dimensions={dimensions} progress={progress} />
      <div className="ms-auto flex flex-none items-center gap-1" role="group" aria-label="Page actions">
        {stuck && <MoveToTopButton onClick={actions.toTop} />}
        {loaded && stuck && view === 'preview' && hasDocumentViewport(document) && <IconButton unsafeDisableTooltip
          size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Fit and recenter page" onClick={actions.fit} />}
        {sidebarToggle}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-4" icon={KebabHorizontalIcon}
              aria-label="Menu" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <BookmarkMenu state={bookmarkState} path={document.path} line={progress?.line ?? 1} page={progress?.bookmarkPage} disabled={!loaded || progress?.pending} />
              <ActionList.LinkItem href={fileUrl(document.path)} target="_blank" rel="noopener noreferrer">
                Open in new tab
              </ActionList.LinkItem>
              <ActionList.LinkItem href={`${apiBase}/asset?path=${encodeURIComponent(document.path)}`}
                target="_blank" rel="noopener noreferrer">
                Open raw file
              </ActionList.LinkItem>
              <ActionList.Item onSelect={() => copy('path', document.path)}>
                Copy path{copied === 'path' ? ' · Copied' : ''}
              </ActionList.Item>
              <ActionList.Item disabled={!document.absolutePath} onSelect={() => document.absolutePath && copy('absolute path', document.absolutePath)}>
                Copy absolute path{copied === 'absolute path' ? ' · Copied' : ''}
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </FileToolbar>
  </>;
}
