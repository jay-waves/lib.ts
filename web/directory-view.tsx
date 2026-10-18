import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { startTransition, useActionState, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CheckIcon, KebabHorizontalIcon, SortDescIcon, FileDirectoryIcon, FileIcon, MarkdownIcon, MaximizeIcon, MinimizeIcon } from '@primer/octicons-react';
import { apiBase, fileUrl, pageBase } from './urls.mjs';
import { readDirectoryGalleryState, saveDirectoryGalleryState } from './directory-state.mjs';
import { formatRelativeModified } from './time-labels.mjs';
import type { TreeNode } from './api/contracts';
import { getMediaDimensions, openDirectory } from './api/library';
import { useClipboard } from './use-clipboard';
import { DirectoryGallery } from './directory-gallery';
import { FileToolbar, MoveToTopButton, useToolbarStuck } from './file-toolbar';
import { bindGalleryZoom, gallerySize, resizeGallery } from './gallery-zoom.mjs';
import { directorySortOptions, gallerySortOptions, galleryImages, isGalleryVideo, mediaKey, sortDirectoryNodes } from './gallery-images';
import type { DirectorySort, GalleryImage } from './gallery-images';

interface DirectoryViewProps {
  directory: { path?: string; absolutePath?: string; children: TreeNode[] };
  navigate(path: string, directory: boolean): void;
}

export function DirectoryView({ directory, navigate }: DirectoryViewProps) {
  const directoryRef = useRef<HTMLDivElement>(null);
  const { stuck, sentinelRef } = useToolbarStuck();
  const [savedGalleryState] = useState(() => readDirectoryGalleryState(pageBase, directory.path));
  const [gallery, setGallery] = useState(() => savedGalleryState.gallery
    ?? history.state?.directoryGallery === true);
  const [rows, setRows] = useState(() => savedGalleryState.rows ?? history.state?.galleryOptions?.rows === true);
  const [recursive, setRecursive] = useState(() => savedGalleryState.recursive ?? history.state?.galleryOptions?.recursive === true);
  const [autoplayVideos, setAutoplayVideos] = useState(() => savedGalleryState.autoplayVideos ?? history.state?.galleryOptions?.autoplayVideos === true);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [width, setWidth] = useState<number>(() => {
    const saved = history.state?.galleryOptions?.width;
    return typeof saved === 'number' && saved >= gallerySize.min && saved <= gallerySize.max ? saved : gallerySize.initial;
  });
  const [sort, setSort] = useState<DirectorySort>(() => {
    const saved = history.state?.galleryOptions?.sort;
    return Object.hasOwn(gallerySortOptions, saved) ? saved : 'name-asc';
  });
  useEffect(() => {
    history.replaceState({ ...history.state, galleryOptions: { recursive, width, sort, autoplayVideos, rows } }, '');
  }, [recursive, width, sort, autoplayVideos, rows]);
  const activeSort = !gallery && sort.startsWith('taken-') ? sort === 'taken-asc' ? 'time-asc' : 'time-desc' : sort;
  const captureSort = gallery && sort.startsWith('taken-');
  const entries = useMemo(() => sortDirectoryNodes(directory.children, activeSort), [directory.children, activeSort]);
  const candidates = useMemo(() => gallery ? galleryImages(directory.children, recursive) : [],
    [directory.children, recursive, gallery]);
  const [capturedAt, setCapturedAt] = useState<Record<string, number | null>>({});
  const images = useMemo(() => sortDirectoryNodes(candidates, sort, capturedAt), [candidates, sort, capturedAt]);
  const [mediaDimensions, setMediaDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [dimensionsLoading, setDimensionsLoading] = useState(false);
  const [metadataError, setMetadataError] = useState('');
  const [naturalRatios, setNaturalRatios] = useState<Record<string, number>>({});
  const onDimensions = useCallback((node: GalleryImage, ratio: number) => {
    if (mediaDimensions[node.path]) return;
    const key = mediaKey(node);
    setNaturalRatios(previous => previous[key] === ratio ? previous : { ...previous, [key]: ratio });
  }, [mediaDimensions]);
  const ratios = useMemo(() => images.map(node => {
    const size = mediaDimensions[node.path];
    return size ? size.width / size.height : naturalRatios[mediaKey(node)] ?? 4 / 3;
  }), [images, mediaDimensions, naturalRatios]);
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
  useEffect(() => {
    setMetadataError('');
    if (!gallery || (!rows && !captureSort) || !candidates.length) { setDimensionsLoading(false); return; }
    const controller = new AbortController();
    setDimensionsLoading(true);
    setMediaDimensions({});
    void (async () => {
      try {
        const dimensions: Record<string, { width: number; height: number }> = {};
        const dates: Record<string, number | null> = {};
        const requested = captureSort && !rows
          ? candidates.filter(node => !isGalleryVideo(node.name) && !/\.svg$/i.test(node.name)) : candidates;
        for (let index = 0; index < requested.length; index += 512) {
          const batch = requested.slice(index, index + 512);
          const response = await getMediaDimensions(apiBase, batch.map(node => node.path), controller.signal, captureSort);
          for (const [path, value] of Object.entries(response.dimensions)) if (value) dimensions[path] = value;
          if (captureSort) for (const node of batch) dates[mediaKey(node)] = response.capturedAt[node.path] ?? null;
        }
        if (!controller.signal.aborted) {
          setMediaDimensions(dimensions);
          if (captureSort) setCapturedAt(dates);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('Could not load gallery metadata', error);
          if (captureSort) setMetadataError('Could not load capture dates. Using available dates or modification times.');
        }
      } finally {
        if (!controller.signal.aborted) setDimensionsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [gallery, rows, captureSort, candidates]);
  function switchGallery(value: boolean) {
    setGallery(value);
    saveDirectoryGalleryState(pageBase, directory.path, { gallery: value });
    history.replaceState({ ...history.state, directoryGallery: value }, '');
  }
  const { copied, error: copyError, copy } = useClipboard();
  const [openError, open, opening] = useActionState(async () => {
    try {
      await openDirectory(apiBase, directory.path);
      return '';
    } catch (error) { return `Could not open directory: ${error instanceof Error ? error.message : String(error)}`; }
  }, '');
  return <div ref={directoryRef}>
    <FileToolbar sentinelRef={sentinelRef} className="flex-wrap items-center gap-3 text-muted">
      <span className="me-auto whitespace-nowrap">{directory.children.length} items</span>
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
              <ActionList.Item disabled={opening} onSelect={() => startTransition(() => open())}>
                {opening ? 'Opening…' : 'Open in system explorer'}
              </ActionList.Item>
              <ActionList.LinkItem href={fileUrl(directory.path ?? '', true)} target="_blank" rel="noopener noreferrer">Open in new tab</ActionList.LinkItem>
              <ActionList.Item onSelect={() => copy('path', directory.path || '.')}>
                Copy path{copied === 'path' ? ' · Copied' : ''}
              </ActionList.Item>
              <ActionList.Item onSelect={() => copy('absolute path', directory.absolutePath)}>
                Copy absolute path{copied === 'absolute path' ? ' · Copied' : ''}
              </ActionList.Item>
              <ActionList.Group selectionVariant="multiple" style={{ marginBlockStart: 0 }}>
                <ActionList.Item className="gallery-menu-toggle" selected={gallery} onSelect={() => switchGallery(!gallery)}>
                  Show gallery
                  <ActionList.TrailingVisual>{gallery ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                </ActionList.Item>
                {gallery && <>
                  <ActionList.Item className="gallery-menu-toggle" selected={rows} onSelect={() => {
                    setRows(!rows);
                    saveDirectoryGalleryState(pageBase, directory.path, { rows: !rows });
                  }}>
                    Adjusted height
                    <ActionList.TrailingVisual>{rows ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                  <ActionList.Item className="gallery-menu-toggle" selected={recursive} onSelect={() => {
                    setRecursive(!recursive);
                    saveDirectoryGalleryState(pageBase, directory.path, { recursive: !recursive });
                  }}>
                    Include subdirectories
                    <ActionList.TrailingVisual>{recursive ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                  <ActionList.Item className="gallery-menu-toggle" selected={autoplayVideos} onSelect={() => {
                    setAutoplayVideos(!autoplayVideos);
                    saveDirectoryGalleryState(pageBase, directory.path, { autoplayVideos: !autoplayVideos });
                  }}>
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
    {captureSort && (dimensionsLoading || metadataError) && <div className="px-3.5 py-2 text-meta text-muted" role="status">
      {dimensionsLoading ? 'Loading capture dates…' : metadataError}
    </div>}
    {gallery ? <DirectoryGallery rows={rows} images={images} width={width} availableWidth={availableWidth} onWidthChange={setAvailableWidth} recursive={recursive} autoplayVideos={autoplayVideos} navigate={navigate} ratios={ratios} onDimensions={onDimensions} dimensionsLoading={dimensionsLoading} /> : entries.map(node => <a className="ui-focus flex min-h-toolbar box-border items-center gap-2 border-0 border-b border-solid border-divider px-3.5 py-2 text-ui text-fg no-underline last:border-b-0 hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted @max-reader-md/reader:px-3 @max-reader-sm/reader:flex-wrap" key={node.path} href={fileUrl(node.path, node.type === 'directory')}
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
