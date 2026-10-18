import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BroadcastIcon, ImageIcon, TriangleIcon } from '@primer/octicons-react';
import type { GalleryImage } from './gallery-images';
import { apiBase, fileUrl } from './urls.mjs';
import './directory-gallery.css';
import { isVideoMedia, isBrowserVideo, mediaKey } from './gallery-images';
import { galleryLayout, galleryRowLayout } from './gallery-layout.mjs';
import { thumbnailUrl, mediaFileUrl } from './media-urls.mjs';

function ImageCard({ node, autoplayVideos, navigate, style }: {
  node: GalleryImage; autoplayVideos: boolean; navigate(path: string, directory: boolean): void;
  style: CSSProperties;
}) {
  const [imageError, setImageError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [playError, setPlayError] = useState(false);
  const videoNode = node.liveVideo ?? (isVideoMedia(node) ? node : undefined);
  const video = !!videoNode;
  const playable = !!videoNode && isBrowserVideo(videoNode);
  const player = useRef<HTMLVideoElement>(null);
  const videoLabel = playError ? 'Cannot play in this browser' : node.liveVideo ? 'Live photo' : 'Video';
  const card = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = useRef(false);
  const hovering = useRef(false);
  const stop = () => { clearTimeout(timer.current); setPlaying(false); setVideoReady(false); };
  useEffect(() => {
    if (!playable || !card.current) return;
    const observer = new IntersectionObserver(entries => {
      visible.current = entries[0].isIntersecting;
      if (visible.current && (autoplayVideos || hovering.current)) setPlaying(true);
      else if (!visible.current) stop();
    });
    observer.observe(card.current);
    const hidden = () => {
      if (document.hidden) stop();
      else if (visible.current && (autoplayVideos || hovering.current)) setPlaying(true);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => { observer.disconnect(); clearTimeout(timer.current); document.removeEventListener('visibilitychange', hidden); };
  }, [playable, autoplayVideos]);
  useEffect(() => {
    if (!autoplayVideos && !hovering.current) stop();
  }, [autoplayVideos]);
  useEffect(() => {
    if (!playing) return;
    let active = true;
    const element = player.current;
    element?.play().catch(() => { if (active) { setPlaying(false); setPlayError(true); } });
    return () => {
      active = false;
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, [playing]);
  return <a className="gallery-card ui-focus" href={fileUrl(node.path)}
    style={style}
    ref={card} onMouseEnter={() => {
      hovering.current = true;
      if (playable && !autoplayVideos) timer.current = setTimeout(() => { setPlayError(false); setPlaying(true); }, 150);
    }}
    onMouseLeave={() => { hovering.current = false; if (!autoplayVideos) stop(); }}
    onBlur={() => { hovering.current = false; if (!autoplayVideos) stop(); }}
    aria-label={`Open ${node.name}${node.liveVideo ? ' (Live photo)' : ''}`} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(node.path, false);
    }}>
    <div className="gallery-image">
      {!imageError && <img src={thumbnailUrl(apiBase, node)}
        alt="" loading="lazy" decoding="async" onError={() => setImageError(true)} />}
      {imageError && <span className="gallery-image-error"><ImageIcon size={24} />
        <span>{video && !node.liveVideo ? 'Could not load video cover' : 'Could not display image'}</span>
      </span>}
      {video && <span className="gallery-video-badge" role="img" aria-label={videoLabel} title={videoLabel}>
        {node.liveVideo ? <BroadcastIcon size={14} /> : <TriangleIcon size={16} />}
      </span>}
      {playable && playing && <video ref={player} className={`gallery-video${videoReady ? ' gallery-video-ready' : ''}`} src={mediaFileUrl(apiBase, videoNode)}
        muted loop playsInline onPlaying={() => setVideoReady(true)}
        onError={() => { stop(); setPlayError(true); }} />}
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
  return <section ref={container} className="directory-gallery" aria-label="Media gallery" data-loading={showLoading && total ? '' : undefined}>
    {total ? <>
      <div className="gallery-loading" role="status"><span className="rendering-label">Rendering</span></div>
      <div className="gallery-content" style={{ height: layout.height }} aria-busy={hasMore}>
        {images.map((node, index) => <ImageCard key={mediaKey(node)} node={node} autoplayVideos={autoplayVideos}
          navigate={navigate} style={layout.items[index]} />)}
      </div>
      {hasMore && !showLoading && <div ref={end} className="gallery-next" aria-hidden="true" />}
    </> : <div className="gallery-empty" role="status"><ImageIcon size={40} />
      <strong>No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectories in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
