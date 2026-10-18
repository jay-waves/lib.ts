import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from 'react';

import { CheckIcon, KebabHorizontalIcon, SortDescIcon, FileDirectoryIcon, FileIcon, MarkdownIcon } from '@primer/octicons-react';
import { apiBase, fileUrl } from './urls.mjs';
import { formatRelativeModified } from './time-labels.mjs';
import type { TreeNode } from './api/contracts';
import { getMediaDimensions, openDirectory } from './api/library';
import { useClipboard } from './use-clipboard';
import { DirectoryGallery } from './directory-gallery';
import { FileToolbar } from './file-toolbar';
import { bindGalleryZoom, gallerySize, resizeGallery } from './gallery-zoom.mjs';
import { directorySortOptions, galleryImages, sortDirectoryNodes } from './gallery-images';
import type { DirectorySort } from './gallery-images';

function WallIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25V2.75A1.75 1.75 0 0 0 14.25 1Zm-.25 1.75a.25.25 0 0 1 .25-.25h5.5v2.75H1.5Zm7 2.5V2.5h5.75a.25.25 0 0 1 .25.25v2.5Zm6 1.5v2.5h-2.75v-2.5Zm-4.25 0v2.5h-4.5v-2.5Zm-6 0v2.5H1.5v-2.5ZM1.5 10.75h5.75v2.75h-5.5a.25.25 0 0 1-.25-.25Zm7 0h6v2.5a.25.25 0 0 1-.25.25H8.5Z" />
  </svg>;
}

interface DirectoryViewProps {
  directory: { path?: string; absolutePath?: string; children: TreeNode[] };
  navigate(path: string, directory: boolean): void;
}

export function DirectoryView({ directory, navigate }: DirectoryViewProps) {
  const directoryRef = useRef<HTMLDivElement>(null);
  const [gallery, setGallery] = useState(() => history.state?.directoryGallery === true);
  const [rows, setRows] = useState(() => history.state?.galleryOptions?.rows === true);
  const [recursive, setRecursive] = useState(() => history.state?.galleryOptions?.recursive === true);
  const [hoverVideos, setHoverVideos] = useState(() => history.state?.galleryOptions?.hoverVideos !== false);
  const [width, setWidth] = useState<number>(() => {
    const saved = history.state?.galleryOptions?.width;
    return typeof saved === 'number' && saved >= gallerySize.min && saved <= gallerySize.max ? saved : gallerySize.initial;
  });
  const [sort, setSort] = useState<DirectorySort>(() => {
    const saved = history.state?.galleryOptions?.sort;
    return Object.hasOwn(directorySortOptions, saved) ? saved : 'name-asc';
  });
  useEffect(() => {
    history.replaceState({ ...history.state, galleryOptions: { recursive, width, sort, hoverVideos, rows } }, '');
  }, [recursive, width, sort, hoverVideos, rows]);
  useEffect(() => {
    const viewport = directoryRef.current?.closest<HTMLElement>('.main-panel');
    if (!gallery || !viewport) return;
    return bindGalleryZoom(viewport, (direction: number, reset: boolean, source: 'wheel' | 'key') => {
      setWidth(value => resizeGallery(value, direction, reset, source === 'wheel' ? gallerySize.wheelStep : gallerySize.step));
    }, { isEnabled: () => !directoryRef.current?.closest('[hidden]') });
  }, [gallery]);
  const entries = useMemo(() => sortDirectoryNodes(directory.children, sort), [directory.children, sort]);
  const images = useMemo(() => gallery ? sortDirectoryNodes(galleryImages(directory.children, recursive), sort) : [],
    [directory.children, recursive, sort, gallery]);
  const [mediaDimensions, setMediaDimensions] = useState<Record<string, { width: number; height: number }>>({});
  const [dimensionsLoading, setDimensionsLoading] = useState(false);
  useEffect(() => {
    if (!gallery || !rows || !images.length) { setDimensionsLoading(false); return; }
    const controller = new AbortController();
    setDimensionsLoading(true);
    setMediaDimensions({});
    void (async () => {
      try {
        const dimensions: Record<string, { width: number; height: number }> = {};
        for (let index = 0; index < images.length; index += 512) {
          const batch = images.slice(index, index + 512);
          const response = await getMediaDimensions(apiBase, batch.map(node => node.path), controller.signal);
          for (const [path, value] of Object.entries(response.dimensions)) if (value) dimensions[path] = value;
        }
        if (!controller.signal.aborted) setMediaDimensions(dimensions);
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Could not load gallery dimensions', error);
      } finally {
        if (!controller.signal.aborted) setDimensionsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [gallery, rows, images]);
  function switchGallery(value: boolean) {
    setGallery(value);
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
    <FileToolbar className="flex-wrap items-center gap-3 text-muted">
      <span className="me-auto whitespace-nowrap">{directory.children.length} items</span>
      {gallery && <div className="gallery-controls">
        <IconButton unsafeDisableTooltip size="small" variant="invisible"
          className="[&_svg]:size-4 aria-pressed:bg-selected! aria-pressed:text-fg!"
          icon={WallIcon} aria-label="Arrange gallery in rows" aria-pressed={rows}
          onClick={() => setRows(value => !value)} />
        <label>Thumbnail size <input type="range" min={gallerySize.min} max={gallerySize.max} step={gallerySize.step} value={width}
          onChange={event => setWidth(Number(event.target.value))} /></label>
      </div>}
      <div className="flex flex-none items-center gap-2" role="group" aria-label="Directory actions">
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-4"
              icon={SortDescIcon} aria-label={`Sort: ${directorySortOptions[sort]}`} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList selectionVariant="single">
              {Object.entries(directorySortOptions).map(([value, label]) => <ActionList.Item key={value}
                selected={sort === value} onSelect={() => setSort(value as DirectorySort)}>{label}</ActionList.Item>)}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton unsafeDisableTooltip size="small" variant="invisible" className="[&_svg]:size-4"
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
              <ActionList.Item onSelect={() => switchGallery(!gallery)}>
                {gallery ? 'Back to file list' : 'Browse as gallery'}
              </ActionList.Item>
              {gallery && <ActionList.Group selectionVariant="multiple" style={{ marginBlockStart: 0 }}>
                  <ActionList.Item className="gallery-menu-toggle" selected={recursive} onSelect={() => setRecursive(value => !value)}>
                    Include subdirectories
                    <ActionList.TrailingVisual>{recursive ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                  <ActionList.Item className="gallery-menu-toggle" selected={hoverVideos} onSelect={() => setHoverVideos(value => !value)}>
                    Play videos on hover
                    <ActionList.TrailingVisual>{hoverVideos ? <CheckIcon /> : null}</ActionList.TrailingVisual>
                  </ActionList.Item>
                </ActionList.Group>}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </FileToolbar>
    {(openError || copyError) && <div className="action-error" role="alert">{openError || copyError}</div>}
    {gallery ? <DirectoryGallery rows={rows} images={images} width={width} recursive={recursive} hoverVideos={hoverVideos} navigate={navigate} dimensions={mediaDimensions} dimensionsLoading={dimensionsLoading} /> : entries.map(node => <a className="ui-focus flex min-h-toolbar box-border items-center gap-2 border-0 border-b border-solid border-divider px-3.5 py-2 text-ui text-fg no-underline last:border-b-0 hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted @max-reader-md/reader:px-3 @max-reader-sm/reader:flex-wrap" key={node.path} href={fileUrl(node.path, node.type === 'directory')}
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
