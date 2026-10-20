import { lazy, Suspense, useState } from 'react';
import { usePreview } from '../preview-context.jsx';
import { OpenMedia } from './open-media';
import { apiBase } from '../urls.mjs';
import { thumbnailUrl, mediaFileUrl } from './media-urls.mjs';
import { loadVideoPlayer } from '../video/video-player-loader';

const LibraryVideoPlayer = lazy(loadVideoPlayer);

export function VideoPreview() {
  const { document, mediaDimensions } = usePreview();
  const [error, setError] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const native = document.playable;
  const poster = thumbnailUrl(apiBase, document);
  const dimensions = mediaDimensions.dimensions;
  const coverStyle = dimensions ? {
    width: `min(100%, ${dimensions.width}px, ${80 * dimensions.width / dimensions.height}vh)`,
    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
  } : undefined;
  const cover = !coverError ? <img className="mx-auto block h-auto max-h-[80vh] max-w-full rounded-ui object-contain"
    style={coverStyle} src={poster} alt={document.name} onError={() => setCoverError(true)} />
    : <div className="mx-auto aspect-video w-full max-h-[80vh] bg-surface" style={coverStyle} />;
  return <div className="p-4">
    {native && !error ? <Suspense fallback={<div role="status" aria-label="Loading video player" aria-busy="true">{cover}</div>}>
      <LibraryVideoPlayer src={mediaFileUrl(apiBase, document)} poster={poster} name={document.name} dimensions={dimensions}
        onDimensions={mediaDimensions.report} onError={() => setError(true)} />
    </Suspense> : cover}
    {(!native || error) && <OpenMedia path={document.path} />}
  </div>;
}
