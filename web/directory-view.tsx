import { ActionList, ActionMenu, IconButton } from '@primer/react';
import { startTransition, useActionState, useEffect, useMemo, useState } from 'react';

import { KebabHorizontalIcon, SortDescIcon, FileDirectoryIcon, FileIcon, MarkdownIcon } from '@primer/octicons-react';
import { apiBase, fileUrl } from './urls.mjs';
import { formatRelativeModified } from './time-labels.mjs';
import type { TreeNode } from './api/contracts';
import { openDirectory } from './api/library';
import { useClipboard } from './use-clipboard';
import { DirectoryGallery } from './directory-gallery';
import { directorySortOptions, galleryImages, sortDirectoryNodes } from './gallery-images';
import type { DirectorySort } from './gallery-images';

interface DirectoryViewProps {
  directory: { path?: string; absolutePath?: string; children: TreeNode[] };
  navigate(path: string, directory: boolean): void;
}

export function DirectoryView({ directory, navigate }: DirectoryViewProps) {
  const [gallery, setGallery] = useState(() => history.state?.directoryGallery === true);
  const [recursive, setRecursive] = useState(() => history.state?.galleryOptions?.recursive === true);
  const [hoverVideos, setHoverVideos] = useState(() => history.state?.galleryOptions?.hoverVideos !== false);
  const [width, setWidth] = useState<number>(() => {
    const saved = history.state?.galleryOptions?.width;
    return typeof saved === 'number' && saved >= 140 && saved <= 420 ? saved : 220;
  });
  const [sort, setSort] = useState<DirectorySort>(() => {
    const saved = history.state?.galleryOptions?.sort;
    return Object.hasOwn(directorySortOptions, saved) ? saved : 'name-asc';
  });
  useEffect(() => {
    history.replaceState({ ...history.state, galleryOptions: { recursive, width, sort, hoverVideos } }, '');
  }, [recursive, width, sort, hoverVideos]);
  const entries = useMemo(() => sortDirectoryNodes(directory.children, sort), [directory.children, sort]);
  const images = useMemo(() => gallery ? sortDirectoryNodes(galleryImages(directory.children, recursive), sort) : [],
    [directory.children, recursive, sort, gallery]);
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
  return <div>
    <div className="flex min-h-toolbar box-border flex-wrap items-center gap-3 border-0 border-b border-solid border-border bg-subtle px-3.5 text-meta text-muted @max-reader-md/reader:ps-3 @max-reader-md/reader:pe-2">
      <span className="me-auto whitespace-nowrap">{directory.children.length} items</span>
      {gallery && <div className="gallery-controls">
        <label>Thumbnail size <input type="range" min="140" max="420" step="20" value={width}
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
              {gallery && <ActionList.Group selectionVariant="multiple">
                <ActionList.Item selected={recursive} onSelect={() => setRecursive(value => !value)}>
                  Include subdirectory
                </ActionList.Item>
                <ActionList.Item selected={hoverVideos} onSelect={() => setHoverVideos(value => !value)}>
                  Play videos on hover
                </ActionList.Item>
              </ActionList.Group>}
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
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
    </div>
    {(openError || copyError) && <div className="action-error" role="alert">{openError || copyError}</div>}
    {gallery ? <DirectoryGallery images={images} width={width} recursive={recursive} hoverVideos={hoverVideos} navigate={navigate} /> : entries.map(node => <a className="ui-focus flex min-h-toolbar box-border items-center gap-2 border-0 border-b border-solid border-divider px-3.5 py-2 text-ui text-fg no-underline last:border-b-0 hover:bg-subtle [&>svg]:shrink-0 [&>svg]:text-muted @max-reader-md/reader:px-3 @max-reader-sm/reader:flex-wrap" key={node.path} href={fileUrl(node.path, node.type === 'directory')}
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
