import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ImageIcon, PlayIcon } from '@primer/octicons-react';
import type { TreeNode } from './api/contracts';
import { RowsPhotoAlbum, type Photo } from 'react-photo-album';
import 'react-photo-album/styles.css';
import { apiBase, fileUrl } from './urls.mjs';
import './directory-gallery.css';
import { isGalleryVideo } from './gallery-images';
import { galleryLayout } from './gallery-layout.mjs';

const mediaKey = (node: TreeNode) => `${node.path}:${node.modified}`;

function ImageCard({ node, hoverVideos, navigate, style, onDimensions }: {
  node: TreeNode; hoverVideos: boolean; navigate(path: string, directory: boolean): void;
  style: CSSProperties; onDimensions(key: string, ratio: number): void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [playing, setPlaying] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [playError, setPlayError] = useState(false);
  const video = isGalleryVideo(node.name);
  const player = useRef<HTMLVideoElement>(null);
  const card = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const query = new URLSearchParams({ path: node.path, v: node.modified });
  const stop = () => { clearTimeout(timer.current); setPlaying(false); setVideoReady(false); };
  useEffect(() => {
    if (!hoverVideos) { stop(); return; }
    if (!video || !card.current) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) stop();
    });
    observer.observe(card.current);
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { observer.disconnect(); clearTimeout(timer.current); document.removeEventListener('visibilitychange', hidden); };
  }, [video, hoverVideos]);
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
    ref={card} onMouseEnter={() => { if (video && hoverVideos) timer.current = setTimeout(() => { setPlayError(false); setPlaying(true); }, 150); }}
    onMouseLeave={stop} onBlur={stop}
    aria-label={`Open ${node.name}`} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(node.path, false);
    }}>
    <div className={`gallery-image gallery-image-${status}`}>
      {status !== 'error' && <img src={`${apiBase}/thumbnail?${query}`}
        alt="" loading="lazy" decoding="async" onLoad={event => {
          const image = event.currentTarget;
          if (image.naturalWidth && image.naturalHeight) onDimensions(mediaKey(node), image.naturalWidth / image.naturalHeight);
          setStatus('ready');
        }} onError={() => setStatus('error')} />}
      {status === 'error' && <span className="gallery-image-error"><ImageIcon size={24} />
        <span>{video ? 'Could not load video cover' : 'Could not display image'}</span>
      </span>}
      {video && <span className="gallery-video-badge"><PlayIcon size={16} />{playError ? 'Cannot play in this browser' : 'Video'}</span>}
      {video && playing && <video ref={player} className={`gallery-video${videoReady ? ' gallery-video-ready' : ''}`} src={`${apiBase}/media?${query}`}
        muted loop playsInline onPlaying={() => setVideoReady(true)}
        onError={() => { stop(); setPlayError(true); }} />}
    </div>
  </a>;
}

export function DirectoryGallery({ images, width, recursive, hoverVideos, rows, navigate, dimensions, dimensionsLoading }: {
  images: TreeNode[]; width: number; recursive: boolean; hoverVideos: boolean; rows: boolean; navigate(path: string, directory: boolean): void;
  dimensions: Record<string, { width: number; height: number }>; dimensionsLoading: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const onDimensions = useCallback((key: string, ratio: number) => {
    setRatios(previous => previous[key] === ratio ? previous : { ...previous, [key]: ratio });
  }, []);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    setAvailableWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [images.length > 0]);
  const layout = galleryLayout(images.map(node => ratios[mediaKey(node)] ?? 4 / 3), availableWidth, width, rows);
  const photos = images.map(node => {
    const size = dimensions[node.path];
    const ratio = size ? size.width / size.height : ratios[mediaKey(node)] ?? 4 / 3;
    const photo: Photo & { node: TreeNode } = {
      key: mediaKey(node), node, src: `${apiBase}/thumbnail?${new URLSearchParams({ path: node.path, v: node.modified })}`,
      width: Math.max(1, Math.round(ratio * 1000)), height: 1000, alt: node.name,
    };
    return photo;
  });
  return <section aria-label="Media gallery">
    {images.length && rows ? <div className="directory-rows-gallery">
      {dimensionsLoading && !Object.keys(dimensions).length ? <div className="gallery-loading" role="status">Loading image dimensions…</div> : <RowsPhotoAlbum
        photos={photos} targetRowHeight={width} spacing={12} padding={0}
        componentsProps={{ container: { className: 'directory-rows-album' } }}
        render={{ photo: ({ onClick }, { photo, width: photoWidth, height: photoHeight }) => <ImageCard
          node={photo.node} hoverVideos={hoverVideos} navigate={navigate}
          style={{ position: 'relative', width: photoWidth, height: photoHeight, flex: 'none' }}
          onDimensions={onDimensions} /> }} />}
    </div> : images.length ? <div className="directory-gallery" ref={container} style={{ height: layout.height }}>
      {images.map((node, index) => <ImageCard key={mediaKey(node)} node={node} hoverVideos={hoverVideos}
        navigate={navigate} style={layout.items[index]} onDimensions={onDimensions} />)}
    </div> : <div className="gallery-empty" role="status"><ImageIcon size={40} />
      <strong>No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectories in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
