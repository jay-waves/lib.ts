import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { BroadcastIcon, ImageIcon, PlayIcon } from '@primer/octicons-react';
import type { GalleryImage } from './gallery-images';
import { StaticPhotoAlbum, type Photo } from 'react-photo-album';
import 'react-photo-album/rows.css';
import { apiBase, fileUrl } from './urls.mjs';
import './directory-gallery.css';
import { isGalleryVideo, mediaKey } from './gallery-images';
import { galleryLayout, galleryRows } from './gallery-layout.mjs';

function ImageCard({ node, autoplayVideos, navigate, style, onDimensions }: {
  node: GalleryImage; autoplayVideos: boolean; navigate(path: string, directory: boolean): void;
  style: CSSProperties; onDimensions(node: GalleryImage, ratio: number): void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [playError, setPlayError] = useState(false);
  const videoNode = node.liveVideo ?? (isGalleryVideo(node.name) ? node : undefined);
  const video = !!videoNode;
  const videoLabel = playError ? 'Cannot play in this browser' : node.liveVideo ? 'Live photo' : 'Video';
  const player = useRef<HTMLVideoElement>(null);
  const card = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visible = useRef(false);
  const hovering = useRef(false);
  const query = new URLSearchParams({ path: node.path, v: node.modified });
  const videoQuery = videoNode && new URLSearchParams({ path: videoNode.path, v: videoNode.modified });
  const stop = () => { clearTimeout(timer.current); setPlaying(false); setVideoReady(false); };
  useEffect(() => {
    if (!video || !card.current) return;
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
  }, [video, autoplayVideos]);
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
      if (video && !autoplayVideos) timer.current = setTimeout(() => { setPlayError(false); setPlaying(true); }, 150);
    }}
    onMouseLeave={() => { hovering.current = false; if (!autoplayVideos) stop(); }}
    onBlur={() => { hovering.current = false; if (!autoplayVideos) stop(); }}
    aria-label={`Open ${node.name}${node.liveVideo ? ' (Live photo)' : ''}`} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(node.path, false);
    }}>
    <div className={`gallery-image gallery-image-${status}`}>
      {status !== 'error' && <img src={`${apiBase}/thumbnail?${query}`}
        alt="" loading="lazy" decoding="async" onLoad={event => {
          const image = event.currentTarget;
          if (image.naturalWidth && image.naturalHeight) onDimensions(node, image.naturalWidth / image.naturalHeight);
          setStatus('ready');
        }} onError={() => setStatus('error')} />}
      {status === 'error' && <span className="gallery-image-error"><ImageIcon size={24} />
        <span>{video && !node.liveVideo ? 'Could not load video cover' : 'Could not display image'}</span>
      </span>}
      {video && <span className="gallery-video-badge" role="img" aria-label={videoLabel} title={videoLabel}>
        {node.liveVideo ? <BroadcastIcon size={14} /> : <PlayIcon size={14} />}
      </span>}
      {video && playing && <video ref={player} className={`gallery-video${videoReady ? ' gallery-video-ready' : ''}`} src={`${apiBase}/media?${videoQuery}`}
        muted loop playsInline onPlaying={() => setVideoReady(true)}
        onError={() => { stop(); setPlayError(true); }} />}
    </div>
  </a>;
}

export function DirectoryGallery({ images, width, availableWidth, onWidthChange, recursive, autoplayVideos, rows, navigate, ratios, onDimensions, dimensionsLoading }: {
  images: GalleryImage[]; width: number; recursive: boolean; autoplayVideos: boolean; rows: boolean; navigate(path: string, directory: boolean): void;
  availableWidth: number; onWidthChange(width: number): void;
  ratios: number[]; onDimensions(node: GalleryImage, ratio: number): void; dimensionsLoading: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    onWidthChange(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => onWidthChange(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [images.length > 0, rows, onWidthChange]);
  const layout = galleryLayout(ratios, availableWidth, width);
  const photos = useMemo(() => images.map((node, index) => {
    const ratio = ratios[index];
    const photo: Photo & { node: GalleryImage } = {
      key: mediaKey(node), node, src: `${apiBase}/thumbnail?${new URLSearchParams({ path: node.path, v: node.modified })}`,
      width: Math.max(1, Math.round(ratio * 1000)), height: 1000, alt: node.name,
    };
    return photo;
  }), [images, ratios]);
  const rowLayout = useMemo(() => rows && availableWidth > 0 ? galleryRows(photos, availableWidth, width) : undefined,
    [rows, photos, availableWidth, width]);
  return <section aria-label="Media gallery">
    {images.length && rows ? <div className="directory-rows-gallery" ref={container}>
      {dimensionsLoading ? <div className="gallery-loading" role="status">Loading image dimensions…</div> : <StaticPhotoAlbum
        layout="rows" model={rowLayout}
        componentsProps={{ container: { className: 'directory-rows-album' } }}
        render={{ photo: (_, { photo, width: photoWidth, height: photoHeight }) => <ImageCard
          node={photo.node} autoplayVideos={autoplayVideos} navigate={navigate}
          style={{ position: 'relative', width: photoWidth, height: photoHeight, flex: 'none' }}
          onDimensions={onDimensions} /> }} />}
    </div> : images.length ? <div className="directory-gallery" ref={container} style={{ height: layout.height }}>
      {images.map((node, index) => <ImageCard key={mediaKey(node)} node={node} autoplayVideos={autoplayVideos}
        navigate={navigate} style={layout.items[index]} onDimensions={onDimensions} />)}
    </div> : <div className="gallery-empty" role="status"><ImageIcon size={40} />
      <strong>No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectories in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
