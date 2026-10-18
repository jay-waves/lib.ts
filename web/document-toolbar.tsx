import './media-details.css';
import { isVideoMedia } from './gallery-images';
import { IconButton } from '@primer/react';
import type { ReactNode, Ref, RefObject } from 'react';
import { ActionList, ActionMenu } from '@primer/react';
import { FocusCenterIcon, KebabHorizontalIcon } from '@primer/octicons-react';
import { BookmarkMenu } from './bookmarks';
import { apiBase, fileUrl } from './urls.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';
import { formatRelativeModified } from './time-labels.mjs';
import type { LibraryDocument } from './api/documents';
import type { BookmarkState } from './bookmarks';
import { useClipboard } from './use-clipboard';
import { FileToolbar, MoveToTopButton } from './file-toolbar';

interface DocumentToolbarProps {
  document: Pick<LibraryDocument, 'path' | 'absolutePath' | 'name' | 'type' | 'size' | 'modified'> & {
    mime?: string;
    lineCount?: number | null;
    imageMetadata?: Extract<LibraryDocument, { type: 'image' }>['imageMetadata'];
    videoMetadata?: Extract<LibraryDocument, { type: 'binary' }>['videoMetadata'];
  };
  status: { view: 'preview' | 'raw'; line?: number | null; pending?: boolean; bookmarkPage?: import('./api/contracts').Bookmark['page'] };
  dimensions?: { width: number; height: number };
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

function durationLabel(seconds: number) {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function bitrateLabel(bitsPerSecond: number) {
  return bitsPerSecond >= 1_000_000
    ? `${(bitsPerSecond / 1_000_000).toFixed(1)} Mb/s`
    : `${Math.round(bitsPerSecond / 1000)} kb/s`;
}

function codecLabel(codec: string) {
  const labels: Record<string, string> = {
    h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1',
    vp8: 'VP8', vp9: 'VP9', prores: 'ProRes', mpeg4: 'MPEG-4', mjpeg: 'Motion JPEG',
  };
  return labels[codec.toLowerCase()] || codec.toUpperCase();
}

export function DocumentToolbar({ document, dimensions, status, stuck, readerRef, sentinelRef, bookmarkState, sidebarToggle }: DocumentToolbarProps) {
  const { copied, error, copy } = useClipboard();
  const imageMetadata = document.type === 'image' ? document.imageMetadata : undefined;
  const videoMetadata = document.type === 'binary' ? document.videoMetadata : undefined;
  const media = document.type === 'image' || (document.type === 'binary' && isVideoMedia(document));
  const details = [
    sizeLabel(document.size),
    ...(document.modified ? [formatRelativeModified(document.modified)] : []),
    ...(imageMetadata?.exif ?? []),
    ...(videoMetadata?.durationSeconds != null ? [durationLabel(videoMetadata.durationSeconds)] : []),
    ...(videoMetadata?.bitrate ? [bitrateLabel(videoMetadata.bitrate)] : []),
    ...(videoMetadata?.codec ? [codecLabel(videoMetadata.codec)] : []),
  ].join(' · ');
  return <>
    {error && <div className="action-error" role="alert">{error}</div>}
    <FileToolbar sentinelRef={sentinelRef} className="items-stretch gap-2">
      <div className="-mb-px flex flex-none items-stretch gap-2 @max-reader-sm/reader:mb-0 @max-reader-sm/reader:min-h-8" role="tablist" aria-label="File view">
        {document.type !== 'text' && <button className="ui-tab" role="tab"
          aria-selected={status.view === 'preview'} onClick={() => readerRef.current?.switchView('preview')}>Preview</button>}
        {!['image', 'pdf', 'binary'].includes(document.type) && <button className="ui-tab" role="tab"
          aria-selected={status.view === 'raw'} onClick={() => readerRef.current?.switchView('raw')}>Raw</button>}
      </div>
      {media ? <div className="media-details ms-3 self-center font-code text-ui text-muted">
        <button type="button" className="media-details-trigger ui-focus" aria-label={`Media information: ${details}`}>
          {dimensions ? `${dimensions.width} × ${dimensions.height} px` : 'Info'}
        </button>
        <div className="media-details-popover">{details}</div>
      </div> : <span className="ms-3 min-w-0 self-center truncate font-code text-ui leading-5 text-muted tabular-nums tracking-[-.15px] @max-reader-sm/reader:ms-0 @max-reader-sm/reader:order-3 @max-reader-sm/reader:basis-full" aria-busy={document.lineCount != null && status.pending}
        >
        {document.lineCount != null && <>{`${status.line ?? '—'} / ${document.lineCount} lines · `}</>}
        {sizeLabel(document.size)}
        {document.modified && <>{' · '}<time dateTime={document.modified}>
          {formatRelativeModified(document.modified)}
        </time></>}
      </span>}
      <div className="ms-auto flex flex-none items-center gap-1" role="group" aria-label="Page actions">
        {stuck && <MoveToTopButton onClick={() => readerRef.current?.toTop()} />}
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
            <BookmarkMenu state={bookmarkState} path={document.path} line={status.line ?? 1} page={status.bookmarkPage} disabled={status.pending} />
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
            <ActionList.Item onSelect={() => copy('absolute path', document.absolutePath)}>
              Copy absolute path{copied === 'absolute path' ? ' · Copied' : ''}
            </ActionList.Item>
          </ActionList>
        </ActionMenu.Overlay>
      </ActionMenu>

      </div>
    </FileToolbar>
  </>;
}
