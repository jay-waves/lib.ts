import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BroadcastIcon, ImageIcon, TriangleIcon } from '@primer/octicons-react';
import type { GalleryImage } from './gallery-images';
import { apiBase, fileUrl } from '../urls.mjs';
import './directory-gallery.css';
import { isVideoMedia, isBrowserVideo, mediaKey } from './gallery-images';
import { galleryLayout, galleryRowLayout } from './gallery-layout.mjs';
import { thumbnailUrl, mediaFileUrl } from '../media/media-urls.mjs';
import { createGalleryPlaybackQueue, createGalleryPreviewCache, startGalleryPlayback } from './gallery-playback.mjs';

function ImageCard({ node, autoplayVideos, navigate, style, playbackQueue, previewCache }: {
  node: GalleryImage; autoplayVideos: boolean; navigate(path: string, directory: boolean): void;
  style: CSSProperties;
  playbackQueue: ReturnType<typeof createGalleryPlaybackQueue>;
  previewCache: ReturnType<typeof createGalleryPreviewCache>;
}) {
  const [imageError, setImageError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [playError, setPlayError] = useState(false);
  const videoNode = node.liveVideo ?? (isVideoMedia(node) ? node : undefined);
  const video = !!videoNode;
  const playable = !!videoNode && isBrowserVideo(videoNode);
  const videoSrc = videoNode ? mediaFileUrl(apiBase, videoNode) : '';
  const player = useRef<HTMLVideoElement>(null);
  const videoLabel = playError ? 'Preview unavailable; open to play' : node.liveVideo ? 'Live photo' : 'Video';
  const card = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = useRef(false);
  const hovering = useRef(false);
  const playback = useRef<ReturnType<typeof startGalleryPlayback> | null>(null);
  const unloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wanted = useRef(false);
  const stop = () => {
    clearTimeout(timer.current);
    clearTimeout(unloadTimer.current);
    previewCache.forget(videoSrc);
    playback.current?.();
    playback.current = null;
    setPlaying(false);
    setVideoReady(false);
  };
  const update = () => {
    const next = visible.current && (autoplayVideos || hovering.current);
    wanted.current = next;
    clearTimeout(timer.current);
    if (next) {
      previewCache.forget(videoSrc);
      clearTimeout(unloadTimer.current);
      setPlayError(false);
      setPlaying(true);
      playback.current?.setEnabled(true);
    } else {
      playback.current?.setEnabled(false);
      if (playback.current) previewCache.retain(videoSrc, stop);
    }
  };
  useEffect(() => {
    if (!playable || !card.current) return;
    const root = card.current.closest('.main-panel');
    const observer = new IntersectionObserver(([entry]) => {
      // Occlusion/background transitions must not be treated as scrolling.
      if (document.hidden) return;
      visible.current = entry.isIntersecting && entry.intersectionRatio > 0;
      update();
    }, { root, rootMargin: '120px 0px', threshold: [0, 0.01] });
    const retention = new IntersectionObserver(([entry]) => {
      if (document.hidden) return;
      clearTimeout(unloadTimer.current);
      if (!entry.isIntersecting) unloadTimer.current = setTimeout(() => {
        if (!document.hidden && !wanted.current) stop();
      }, 5000);
    }, { root, rootMargin: '800px 0px' });
    observer.observe(card.current);
    retention.observe(card.current);
    return () => {
      observer.disconnect(); retention.disconnect();
      clearTimeout(timer.current); clearTimeout(unloadTimer.current);
    };
  }, [playable, autoplayVideos, videoSrc, previewCache]);
  useEffect(() => { update(); }, [autoplayVideos]);
  useEffect(() => {
    if (!playing) return;
    const element = player.current;
    if (!element || !videoSrc) return;
    const control = startGalleryPlayback(element, videoSrc, {
      queue: playbackQueue, enabled: wanted.current,
      dimensions: node.liveVideo ? undefined : node.dimensions,
      onReady: setVideoReady,
      onError: () => { stop(); setPlayError(true); },
    });
    playback.current = control;
    return () => {
      control(); playback.current = null;
      previewCache.forget(videoSrc);
    };
  }, [playing, videoSrc, playbackQueue, previewCache]);
  return <a className="gallery-card absolute box-border overflow-hidden rounded-lg border border-solid border-divider bg-subtle text-fg no-underline transition-[border-color,box-shadow] duration-160 ease-[ease] hover:z-2 focus-visible:z-2 motion-reduce:transition-none" href={fileUrl(node.path)}
    style={style}
    ref={card} onMouseEnter={() => {
      hovering.current = true;
      if (playable) timer.current = setTimeout(update, 150);
    }}
    onMouseLeave={() => { hovering.current = false; update(); }}
    onBlur={() => { hovering.current = false; update(); }}
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
      {playable && playing && <video ref={player} className={`pointer-events-none absolute inset-0 size-full bg-subtle object-contain ${videoReady ? 'visible' : 'invisible'}`}
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
    </> : <div className="ui-empty px-6 py-16 text-ui" role="status"><ImageIcon size={40} />
      <strong className="text-base leading-5 text-fg">No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectories in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
