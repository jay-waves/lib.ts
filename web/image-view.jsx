import React, { useMemo, useState } from 'react';
import { DocumentPreview } from './document-preview.jsx';
import { imageDocumentLayout } from './document-preview.mjs';
import { useReader } from './reader-context.jsx';
import { apiBase } from './urls.mjs';
import { imagePreviewUrls } from './media-urls.mjs';

export function ImagePreview() {
  const { document, viewport } = useReader();
  const [measuredSize, setMeasuredSize] = useState(null);
  const [status, setStatus] = useState('loading');
  const size = document.imageMetadata?.dimensions || measuredSize;
  const layout = useMemo(() => imageDocumentLayout(size), [size]);
  const { thumbnail, source } = imagePreviewUrls(apiBase, document);
  const placeholder = thumbnail !== source && Boolean(size);
  return <DocumentPreview layout={layout}>
    <div className="flex flex-col items-center" data-dim-images>
      <div className="document-page image-preview-page" data-page="1" data-ready={status === 'ready' ? '' : undefined}
        style={{ width: size ? `${size.width * viewport.scale}px` : 0,
          visibility: size ? undefined : 'hidden', aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}>
        {placeholder && <img className="image-preview-placeholder" src={thumbnail} alt="" aria-hidden="true" draggable={false}
          onError={event => { event.currentTarget.style.visibility = 'hidden'; }} />}
        <img className={`image-preview-full${placeholder ? ' image-preview-transition' : ''}`}
          src={source} alt={document.name} draggable={false} decoding="async" onLoad={event => {
            if (!document.imageMetadata?.dimensions) {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width && height) setMeasuredSize({ width, height });
            }
            setStatus('ready');
          }} onError={() => setStatus('error')} />
      </div>
      {status === 'error' && <div className="status" role="alert"><p>{/\.(heic|heif)$/i.test(document.name)
        ? 'Could not preview HEIC/HEIF. The server needs FFmpeg 8.1 or newer with HEVC support.'
        : 'Could not display image'}</p><a href={document.url} download={document.name}>Download original</a></div>}
    </div>
  </DocumentPreview>;
}
