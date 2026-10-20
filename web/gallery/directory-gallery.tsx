import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BroadcastIcon, ImageIcon, TriangleIcon } from '@primer/octicons-react';
import type { GalleryImage } from './gallery-images';
import { apiBase, fileUrl } from '../urls.mjs';
import './directory-gallery.css';
import { isVideoMedia, isBrowserVideo, mediaKey } from './gallery-images';
import { galleryLayout, galleryRowLayout } from './gallery-layout.mjs';
import { thumbnailUrl, mediaFileUrl } from '../media/media-urls.mjs';
import { createGalleryPlaybackQueue, createGalleryPreviewCache } from './gallery-playback.mjs';
import { useGalleryPlayback } from './use-gallery-playback';

function ImageCard({ node, autoplayVideos, navigate, style, playbackQueue, previewCache }: {
  node: GalleryImage; autoplayVideos: boolean; navigate(path: string, directory: boolean): void;
  style: CSSProperties;
  playbackQueue: ReturnType<typeof createGalleryPlaybackQueue>;
  previewCache: ReturnType<typeof createGalleryPreviewCache>;
}) {
  const [imageError, setImageError] = useState(false);
  const videoNode = node.liveVideo ?? (isVideoMedia(node) ? node : undefined);
  const video = !!videoNode;
  const playable = !!videoNode && isBrowserVideo(videoNode);
  const playback = useGalleryPlayback({
    src: videoNode ? mediaFileUrl(apiBase, videoNode) : '', playable, autoplay: autoplayVideos,
    dimensions: node.liveVideo ? undefined : node.dimensions, queue: playbackQueue, cache: previewCache,
  });
  const videoLabel = playback.error ? 'Preview unavailable; hover to retry or open to play'
    : playback.queued ? 'Waiting to play; hover to play' : node.liveVideo ? 'Live photo' : 'Video';
  return <a className="gallery-card absolute box-border overflow-hidden rounded-lg border border-solid border-divider bg-subtle text-fg no-underline transition-[border-color,box-shadow] duration-160 ease-[ease] hover:z-2 focus-visible:z-2 motion-reduce:transition-none" href={fileUrl(node.path)}
    style={style}
    ref={playback.card} onMouseEnter={playback.onMouseEnter} onMouseLeave={playback.onMouseLeave}
    onFocus={playback.onFocus} onBlur={playback.onBlur}
    aria-label={`Open ${node.name}${node.liveVideo ? ' (Live photo)' : ''}`} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(node.path, false);
    }}>
    <div className="relative h-full overflow-hidden">
      {!imageError && <img className="block size-full object-contain" src={thumbnailUrl(apiBase, node)}
        alt="" loading="lazy" decoding="async" onError={() => setImageError(true)} />}
      {imageError && <span className="flex h-full box-border flex-col items-center justify-center gap-2 p-4 text-center text-ui text-muted wrap-anywhere"><ImageIcon size={24} />
        <span>{video && !node.liveVideo ? 'Could not load video cover' : 'Could not display image'}</span>
      </span>}
      {video && <span className="absolute right-2 bottom-2 z-1 flex rounded bg-[#0004] p-[3px] text-white opacity-65" role="img" aria-label={videoLabel} title={videoLabel}>
        {node.liveVideo ? <BroadcastIcon size={14} /> : <TriangleIcon size={16} />}
      </span>}
      {playable && <video ref={playback.player} className={`pointer-events-none absolute inset-0 size-full bg-subtle object-contain ${playback.ready ? 'visible' : 'invisible'}`}
        muted loop playsInline preload="none" />}
    </div>
  </a>;
}

export function DirectoryGallery({ images, total, hasMore, loadMore, width, availableWidth, onWidthChange, recursive, autoplayVideos, rows, navigate, ratios, dimensionsLoading }: {
  images: GalleryImage[]; total: number; hasMore: boolean; loadMore(): void;
  width: number; recursive: boolean; autoplayVideos: boolean; rows: boolean; navigate(path: string, directory: boolean): void;
  availableWidth: number; onWidthChange(width: number): void;
  ratios: number[]; dimensionsLoading: boolean;
}) {
  const container = useRef<HTMLElement>(null);
  const [playbackQueue] = useState(() => createGalleryPlaybackQueue());
  const [previewCache] = useState(() => createGalleryPreviewCache());
  const end = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current;
    const viewport = element?.closest<HTMLElement>('.main-panel');
    if (!element || !viewport) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width) return;
      onWidthChange(rect.width);
      const top = rect.top - viewport.getBoundingClientRect().top + viewport.scrollTop;
      element.style.setProperty('--gallery-min-height', `${Math.max(120, viewport.clientHeight - top - 14)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [onWidthChange]);
  const layout = useMemo(() => (rows ? galleryRowLayout : galleryLayout)(ratios, availableWidth, width),
    [rows, ratios, availableWidth, width]);
  const showLoading = dimensionsLoading || availableWidth <= 0;
  useEffect(() => {
    const target = end.current;
    const viewport = container.current?.closest<HTMLElement>('.main-panel');
    if (showLoading || !hasMore || !target || !viewport) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) loadMore();
    }, { root: viewport, rootMargin: `${viewport.clientHeight}px 0px` });
    observer.observe(target);
    return () => observer.disconnect();
  }, [showLoading, hasMore, images.length, availableWidth, loadMore]);
  return <section ref={container} className="directory-gallery relative m-3.5 min-h-[var(--gallery-min-height,120px)]" aria-label="Media gallery" data-loading={showLoading && total ? '' : undefined}>
    {total ? <>
      <div className="gallery-loading absolute inset-x-0 top-0 hidden h-[var(--gallery-min-height,120px)] place-items-center" role="status"><span className="rendering-label">Rendering</span></div>
      <div className="gallery-content relative" style={{ height: layout.height }} aria-busy={hasMore}>
        {images.map((node, index) => <ImageCard key={mediaKey(node)} node={node} autoplayVideos={autoplayVideos}
          navigate={navigate} style={layout.items[index]} playbackQueue={playbackQueue} previewCache={previewCache} />)}
      </div>
      {hasMore && !showLoading && <div ref={end} className="h-px" aria-hidden="true" />}
    </> : dimensionsLoading ? <div className="status" role="status">Loading media directories…</div>
      : <div className="ui-empty px-6 py-16 text-ui" role="status"><ImageIcon size={40} />
      <strong className="text-base leading-5 text-fg">No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectories in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
