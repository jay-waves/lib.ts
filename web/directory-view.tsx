import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CheckIcon, KebabHorizontalIcon, SortDescIcon, FileDirectoryIcon, FileIcon, MarkdownIcon, MaximizeIcon, MinimizeIcon } from '@primer/octicons-react';
import { fileUrl, pageBase } from './urls.mjs';
import { readDirectoryState, readRepositoryDisplayState, saveDirectoryState } from './directory-state.mjs';
import { useDirectoryScroll } from './use-directory-scroll';
import { formatRelativeModified } from './history/time-labels.mjs';
import type { TreeNode } from './api/contracts';
import { useSystemOpen } from './media/use-system-open';
import { useClipboard } from './use-clipboard';
import { DirectoryGallery } from './gallery/directory-gallery';
import { useGalleryMedia } from './gallery/use-gallery-media';
import { FileToolbar, MoveToTopButton, useToolbarStuck } from './file-toolbar';
import { bindGalleryZoom, gallerySize, resizeGallery } from './gallery/gallery-zoom.mjs';
import { directorySortOptions, gallerySortOptions, galleryImages, isBrowserVideo, sortDirectoryNodes } from './gallery/gallery-images';
import type { DirectorySort } from './gallery/gallery-images';
import { preloadVideoPlayer } from './video/video-player-loader';

interface DirectoryViewProps {
  directory: { path?: string; absolutePath?: string; children?: TreeNode[] };
  navigate(path: string, directory: boolean): void;
  display: ReturnType<typeof readRepositoryDisplayState>;
  onDisplayChange(patch: ReturnType<typeof readRepositoryDisplayState>): void;
}

const emptyChildren: TreeNode[] = [];

export function DirectoryView({ directory, navigate, display, onDisplayChange }: DirectoryViewProps) {
  const directoryRef = useRef<HTMLDivElement>(null);
  const { stuck, sentinelRef } = useToolbarStuck();
  const [savedState] = useState(() => readDirectoryState(pageBase, directory.path));
  const { gallery = false, rows = false, recursive = false, autoplayVideos = false, showHidden = false } = display;
  const children = directory.children ?? emptyChildren;
  const [availableWidth, setAvailableWidth] = useState(0);
  const [width, setWidth] = useState<number>(() => savedState.width ?? gallerySize.initial);
  const [sort, setSort] = useState<DirectorySort>(() => savedState.sort ?? 'name-asc');
  useEffect(() => {
    saveDirectoryState(pageBase, directory.path, { width, sort });
  }, [directory.path, width, sort]);
  const activeSort = !gallery && sort.startsWith('taken-') ? sort === 'taken-asc' ? 'time-asc' : 'time-desc' : sort;
  const entries = useMemo(() => gallery ? [] : sortDirectoryNodes(children, activeSort), [children, activeSort, gallery]);
  const candidates = useMemo(() => gallery ? galleryImages(children, recursive) : [],
    [children, recursive, gallery]);
  const hasPlayableVideo = candidates.some(isBrowserVideo);
  useEffect(() => {
    if (hasPlayableVideo) preloadVideoPlayer();
  }, [hasPlayableVideo]);
  const { images, ratios, loading: dimensionsLoading, hasMore, loadMore, error: metadataError } = useGalleryMedia(candidates, sort);
  useDirectoryScroll(directoryRef, pageBase, directory.path ?? '',
    !gallery || availableWidth > 0 && !dimensionsLoading, !gallery || !hasMore, loadMore);
  const zoomSteps = useMemo(() => dimensionsLoading || !ratios.length || !availableWidth
    ? { smaller: width, larger: width }
    : {
      smaller: resizeGallery(width, -1, false, availableWidth, rows, ratios),
      larger: resizeGallery(width, 1, false, availableWidth, rows, ratios),
    }, [width, availableWidth, rows, ratios, dimensionsLoading]);
  const changeSize = useCallback((direction: number, reset = false) => {
    setWidth(value => resizeGallery(value, direction, reset, availableWidth, rows, ratios));
  }, [availableWidth, rows, ratios]);
  useEffect(() => {
    const viewport = directoryRef.current?.closest<HTMLElement>('.main-panel');
    if (!gallery || !viewport) return;
    return bindGalleryZoom(viewport, changeSize, { isEnabled: () => !directoryRef.current?.closest('[hidden]') });
  }, [gallery, changeSize]);
  const { copied, error: copyError, copy } = useClipboard();
  const { error: openError, open, pending: opening } = useSystemOpen('directory', directory.path);
  return <div ref={directoryRef}>
    <FileToolbar sentinelRef={sentinelRef} className="flex-wrap items-center gap-3 text-muted">
      <span className="me-auto whitespace-nowrap">{children.length} items</span>
      <div className="flex flex-none items-center gap-2 [&_svg]:size-4" role="group" aria-label="Directory actions">
      {stuck && <MoveToTopButton />}
      {gallery && <>
        <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-[15px]!"
          icon={MinimizeIcon} aria-label="Decrease thumbnail size by one step"
          disabled={!images.length || dimensionsLoading || zoomSteps.smaller === width} onClick={() => changeSize(-1)} />
        <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-[15px]!"
          icon={MaximizeIcon} aria-label="Increase thumbnail size by one step"
          disabled={!images.length || dimensionsLoading || zoomSteps.larger === width} onClick={() => changeSize(1)} />
      </>}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton unsafeDisableTooltip size="small" variant="invisible"
              icon={SortDescIcon} aria-label={`Sort: ${gallerySortOptions[activeSort]}`} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList selectionVariant="single">
              {Object.entries(gallery ? gallerySortOptions : directorySortOptions).map(([value, label]) => <ActionList.Item key={value}
                selected={activeSort === value} onSelect={() => setSort(value as DirectorySort)}>{label}</ActionList.Item>)}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton unsafeDisableTooltip size="small" variant="invisible"
              icon={KebabHorizontalIcon} aria-label="Menu" />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <ActionList.Item disabled={opening} onSelect={open}>
                {opening ? 'Opening…' : 'Open in system explorer'}
              </ActionList.Item>
              <ActionList.LinkItem href={fileUrl(directory.path ?? '', true)} target="_blank" rel="noopener noreferrer">Open in new tab</ActionList.LinkItem>
              <ActionList.Item onSelect={() => copy('path', directory.path || '.')}>
                Copy path{copied === 'path' ? ' · Copied' : ''}
              </ActionList.Item>
              <ActionList.Item onSelect={() => copy('absolute path', directory.absolutePath)}>
                Copy absolute path{copied === 'absolute path' ? ' · Copied' : ''}
              </ActionList.Item>
              <ActionList.Divider style={{ opacity: .5 }} />
              <ActionList.Group selectionVariant="multiple" style={{ marginBlockStart: 0 }}>
                <ActionList.Item className="gallery-menu-toggle" selected={showHidden} onSelect={() => onDisplayChange({ showHidden: !showHidden })}>
                  Show hidden files
                  <ActionList.TrailingVisual>{showHidden ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                </ActionList.Item>
                <ActionList.Item className="gallery-menu-toggle" selected={gallery} onSelect={() => onDisplayChange({ gallery: !gallery })}>
                  Show gallery
                  <ActionList.TrailingVisual>{gallery ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                </ActionList.Item>
                {gallery && <>
                  <ActionList.Item className="gallery-menu-toggle" selected={rows} onSelect={() => onDisplayChange({ rows: !rows })}>
                    Adjusted height
                    <ActionList.TrailingVisual>{rows ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                  <ActionList.Item className="gallery-menu-toggle" selected={recursive} onSelect={() => onDisplayChange({ recursive: !recursive })}>
                    Include subdirectories
                    <ActionList.TrailingVisual>{recursive ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                  <ActionList.Item className="gallery-menu-toggle" selected={autoplayVideos} onSelect={() => onDisplayChange({ autoplayVideos: !autoplayVideos })}>
                    Autoplay videos
                    <ActionList.TrailingVisual>{autoplayVideos ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                </>}
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </FileToolbar>
    {(openError || copyError) && <div className="action-error" role="alert">{openError || copyError}</div>}
    {gallery ? <DirectoryGallery rows={rows} images={images} total={candidates.length} hasMore={hasMore} loadMore={loadMore} width={width} availableWidth={availableWidth} onWidthChange={setAvailableWidth} recursive={recursive} autoplayVideos={autoplayVideos} navigate={navigate} ratios={ratios} dimensionsLoading={dimensionsLoading} /> : entries.map(node => <a className="ui-focus flex min-h-toolbar box-border items-center gap-2 border-0 border-b border-solid border-divider px-3.5 py-2 text-ui text-fg no-underline last:border-b-0 hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted @max-reader-md/reader:px-3 @max-reader-sm/reader:flex-wrap" key={node.path} href={fileUrl(node.path, node.type === 'directory')}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(node.path, node.type === 'directory');
      }}>
      {node.type === 'directory' ? <FileDirectoryIcon /> : node.name.toLowerCase().endsWith('.md') ? <MarkdownIcon /> : <FileIcon />}
      <span className="min-w-0 truncate @max-reader-sm/reader:flex-1">{node.name}</span>
      {node.type === 'directory' && node.modified && <time className="ms-auto flex-none whitespace-nowrap text-meta text-muted @max-reader-sm/reader:ms-6 @max-reader-sm/reader:w-[calc(100%-24px)]" dateTime={node.modified}
        >{formatRelativeModified(node.modified)}</time>}
    </a>)}
    {gallery && metadataError && <div className="px-3.5 py-2 text-meta text-muted" role="status">{metadataError}</div>}
  </div>;
}
