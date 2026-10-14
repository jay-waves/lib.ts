import React, { useMemo, useState } from 'react';
import { DocumentPreview } from './document-preview.jsx';
import { imageDocumentLayout } from './document-preview.mjs';
import { useReader } from './reader-context.jsx';
import styles from './image-view.module.css';

export function ImagePreview() {
  const { document, viewport, assetVersions } = useReader();
  const version = assetVersions[document.path];
  const [size, setSize] = useState(null);
  const [error, setError] = useState(false);
  const layout = useMemo(() => imageDocumentLayout(size), [size]);
  return <DocumentPreview layout={layout}>
    <div className={styles.pages} data-dim-images>
      <div className={[styles.page, 'document-page'].join(' ')} data-page="1" style={{ width: size ? `${size.width * viewport.scale}px` : 'max-content',
        aspectRatio: size ? `${size.width} / ${size.height}` : undefined }}>
        <img src={`${document.url}&v=${encodeURIComponent(`${document.modified}:${version || 0}`)}`}
          alt={document.name} draggable={false} onLoad={event => {
            const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
            if (width && height) setSize({ width, height });
            setError(false);
          }} onError={() => setError(true)} />
        {error && <div className="status" role="alert">Could not display image</div>}
      </div>
    </div>
  </DocumentPreview>;
}
