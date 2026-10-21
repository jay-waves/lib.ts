import { useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { PreviewContext } from '../preview-context.jsx';
import { ImagePreview } from './image-view.jsx';
import { VideoPreview } from './media-preview.jsx';
import { pageReaderOnSpace } from '../reader-keyboard.mjs';

// Media has transient zoom/playback state, without reading-position restoration,
// progress saves or the document reader's scroll/resize tracking.
export function MediaReader({ ref, document, mediaDimensions, active, request }) {
  const root = useRef(null);
  const [scale, setScale] = useState(1);
  const [fitRequest, setFitRequest] = useState(0);
  const image = document.type === 'image';
  useLayoutEffect(() => {
    const panel = root.current?.closest('.main-panel');
    panel?.classList.remove('pathbar-hidden');
    panel?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [document.path]);
  useImperativeHandle(ref, () => ({
    toTop: () => root.current?.closest('.main-panel')?.scrollTo({ top: 0, behavior: 'smooth' }),
    fit: () => setFitRequest(value => value + 1),
    handleKeyDown: event => {
      if (image) pageReaderOnSpace(event, root.current?.closest('.main-panel'), 'image', 'preview');
    },
  }));
  return <PreviewContext value={{ document, mediaDimensions, viewport: { scale, fitRequest, onScale: setScale } }}>
    <div ref={root} className="reader">{image
      ? <ImagePreview key={`${document.path}:${document.modified}`} />
      : <VideoPreview key={`${document.path}:${document.modified}`} active={active}
          initialTime={request?.path === document.path ? request.playbackTime : undefined} />}</div>
  </PreviewContext>;
}
