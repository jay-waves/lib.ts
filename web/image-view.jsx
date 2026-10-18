import React, { useMemo, useState } from 'react';
import { DocumentPreview } from './document-preview.jsx';
import { imageDocumentLayout } from './document-preview.mjs';
import { useReader } from './reader-context.jsx';
import { apiBase } from './urls.mjs';

export function ImagePreview() {
  const { document, viewport, assetVersions } = useReader();
  const version = assetVersions[document.path];
  const [size, setSize] = useState(null);
  const [error, setError] = useState(false);
  const layout = useMemo(() => imageDocumentLayout(size), [size]);
  const converted = /\.(heic|heif)$/i.test(document.name);
  const imageUrl = converted
    ? `${apiBase}/thumbnail?${new URLSearchParams({ path: document.path, preview: 'true' })}`
    : document.url;
  return <DocumentPreview layout={layout}>
    <div className="flex flex-col items-center" data-dim-images>
      <div className="document-page [&>img]:block [&>img]:h-auto [&>img]:w-full [&>img]:object-contain" data-page="1" style={{ width: size ? `${size.width * viewport.scale}px` : error ? 'max-content' : 0,
        visibility: size || error ? undefined : 'hidden',
        aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}>
        <img src={`${imageUrl}&v=${encodeURIComponent(`${document.modified}:${version || 0}`)}`}
          alt={document.name} draggable={false} onLoad={event => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            if (width && height) setSize({ width, height });
            setError(false);
          }} onError={() => setError(true)} />
        {error && <div className="status" role="alert"><p>{converted
          ? 'Could not preview HEIC/HEIF. The server needs FFmpeg 8.1 or newer with HEVC support.'
          : 'Could not display image'}</p><a href={document.url} download={document.name}>Download original</a></div>}
      </div>
    </div>
  </DocumentPreview>;
}
