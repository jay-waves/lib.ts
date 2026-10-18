import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ImageIcon, PlayIcon } from '@primer/octicons-react';
import type { TreeNode } from './api/contracts';
import { apiBase, fileUrl } from './urls.mjs';
import './directory-gallery.css';
import { isGalleryVideo } from './gallery-images';

function ImageCard({ node, hoverVideos, navigate }: {
  node: TreeNode; hoverVideos: boolean; navigate(path: string, directory: boolean): void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(false);
  const video = isGalleryVideo(node.name);
  const player = useRef<HTMLVideoElement>(null);
  const card = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const query = new URLSearchParams({ path: node.path, v: node.modified });
  const stop = () => { clearTimeout(timer.current); setPlaying(false); };
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
    ref={card} onMouseEnter={() => { if (video && hoverVideos) timer.current = setTimeout(() => { setPlayError(false); setPlaying(true); }, 150); }}
    onMouseLeave={stop} onBlur={stop}
    aria-label={`Open ${node.name}`} onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); navigate(node.path, false);
    }}>
    <div className={`gallery-image gallery-image-${status}`}>
      {status !== 'error' && <img src={`${apiBase}/thumbnail?${query}`}
        alt="" loading="lazy" decoding="async" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
      {status === 'error' && <span className="gallery-image-error"><ImageIcon size={24} />
        <span>{video ? 'Could not load video cover' : 'Could not display image'}</span>
      </span>}
      {video && <span className="gallery-video-badge"><PlayIcon size={16} />{playError ? 'Cannot play in this browser' : 'Video'}</span>}
      {video && playing && <video ref={player} className="gallery-video" src={`${apiBase}/media?${query}`}
        muted loop playsInline onError={() => { setPlaying(false); setPlayError(true); }} />}
    </div>
  </a>;
}

export function DirectoryGallery({ images, width, recursive, hoverVideos, navigate }: {
  images: TreeNode[]; width: number; recursive: boolean; hoverVideos: boolean; navigate(path: string, directory: boolean): void;
}) {
  return <section aria-label="Media gallery">
    {images.length ? <div className="directory-gallery" style={{ '--gallery-width': `${width}px` } as CSSProperties}>
      {images.map(node => <ImageCard key={`${node.path}:${node.modified}`} node={node} hoverVideos={hoverVideos} navigate={navigate} />)}
    </div> : <div className="gallery-empty" role="status"><ImageIcon size={40} />
      <strong>No images or videos in this folder</strong>
      <span>{recursive ? 'Try another folder or return to the file list.' : 'Enable Include subdirectory in the menu to look for more media.'}</span>
    </div>}
  </section>;
}
