import { IconButton } from '@primer/react';
import type { ReactNode, Ref, RefObject } from 'react';
import { ActionList, ActionMenu } from '@primer/react';
import { ArrowUpIcon, FocusCenterIcon, KebabHorizontalIcon } from '@primer/octicons-react';
import { BookmarkMenu } from './bookmarks';
import { apiBase, fileUrl } from './urls.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';
import { formatRelativeModified } from './time-labels.mjs';
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
    <div className="pointer-events-none h-px flex-none -mb-px" ref={sentinelRef} aria-hidden="true" />
    <div className="file-toolbar ui-toolbar flex-none items-stretch gap-2">
      <div className="-mb-px flex flex-none items-stretch gap-2 @max-reader-sm/reader:mb-0 @max-reader-sm/reader:min-h-8" role="tablist" aria-label="File view">
        {document.type !== 'text' && <button className="ui-tab" role="tab"
          aria-selected={status.view === 'preview'} onClick={() => readerRef.current?.switchView('preview')}>Preview</button>}
        {!['image', 'pdf', 'binary'].includes(document.type) && <button className="ui-tab" role="tab"
          aria-selected={status.view === 'raw'} onClick={() => readerRef.current?.switchView('raw')}>Raw</button>}
      </div>
      <span className="ms-3 min-w-0 self-center truncate font-code text-[10px] leading-4 text-muted tabular-nums tracking-[-.15px] @max-reader-sm/reader:ms-0 @max-reader-sm/reader:order-3 @max-reader-sm/reader:basis-full" aria-busy={document.lineCount != null && status.pending}>
        {document.lineCount != null && <>{`${status.line ?? '—'} / ${document.lineCount} lines · `}</>}
        {sizeLabel(document.size)}
        {document.modified && <>{' · '}<time dateTime={document.modified}>
          {formatRelativeModified(document.modified)}
        </time></>}
      </span>
      <div className="ms-auto flex flex-none items-center gap-1" role="group" aria-label="Page actions">
        {stuck && <IconButton unsafeDisableTooltip size="small" variant="invisible" icon={ArrowUpIcon} aria-label="Back to top" onClick={() => readerRef.current?.toTop()} />}
        {stuck && status.view === 'preview' && hasDocumentViewport(document) && <IconButton unsafeDisableTooltip
          size="small" variant="invisible" icon={FocusCenterIcon} aria-label="Fit and recenter page" onClick={() => readerRef.current?.fit()} />}
        {sidebarToggle}
      <ActionMenu>
        <ActionMenu.Anchor>
          <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-4" icon={KebabHorizontalIcon}
            aria-label="Menu" />
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
