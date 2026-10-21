import React, { useCallback, useImperativeHandle, useRef } from 'react';
import { Preview } from './preview.jsx';
import { RawView } from './raw/raw-view.jsx';
import { useReaderSession } from './use-reader-session.jsx';
import { pageReaderOnSpace } from './reader-keyboard.mjs';
import { PreviewContext } from './preview-context.jsx';
import { MediaReader } from './media/media-reader.jsx';
import { isMediaPreview } from './preview-kind.mjs';
import { MarkdownPreview } from './markdown/preview.jsx';

export function Reader(props) {
  // DocumentReader owns navigation and persisted reading state. MediaReader owns
  // transient zoom/playback only and must not report document reading progress.
  if (isMediaPreview(props.document)) return <MediaReader {...props} />;
  return <DocumentReader {...props} />;
}

function DocumentReader({ ref, document, request, view, onViewChange, navigate, onReload, onProgress, bookmarkState, prepared, assetVersions }) {
  const root = useRef(null);
  const session = useReaderSession({ document, root, request, view, onViewChange, onProgress });
  useImperativeHandle(ref, () => ({
    ...session.actions,
    handleKeyDown: event => pageReaderOnSpace(event, root.current?.closest('.main-panel'), document.type, view),
  }));
  const onExpired = useExpiredPages(onReload);
  return <PreviewContext value={{ document, viewport: session.viewport, onExpired }}>
    <div ref={root} className="reader" onClick={session.click}>
      {view === 'raw' ? <RawView document={document} targetLine={session.targetLine} navigationRequest={request} bookmarkState={bookmarkState} />
        : document.type === 'markdown' ? prepared
          ? <MarkdownPreview path={document.path} prepared={prepared} assetVersions={assetVersions} navigate={navigate} />
          : <div className="status">Loading preview…</div>
        : <Preview />}
    </div>
  </PreviewContext>;
}

function useExpiredPages(onReload) {
  const expired = useRef(''), reload = useRef(onReload);
  reload.current = onReload;
  return useCallback(pageUrl => {
    const id = new URL(pageUrl, location.href).searchParams.get('id');
    if (expired.current === id) return;
    expired.current = id;
    reload.current();
  }, []);
}
