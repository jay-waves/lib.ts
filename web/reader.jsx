import React, { useCallback, useContext, useImperativeHandle, useMemo, useRef } from 'react';
import { ReaderContext } from './reader-context.jsx';
import { SessionActivity } from './session-activity';
import { Preview } from './preview.jsx';
import { RawView } from './raw-view.jsx';
import { prepareMarkdown } from './markdown/markdown.mjs';
import { useReaderWatch } from './reader-watch.jsx';
import { useReaderSession } from './use-reader-session.jsx';
import { apiBase, fileUrl } from './urls.mjs';

function documentLink(path) {
  return /\.(?:md|typ|html?)$/i.test(path) ? fileUrl(path) : `${apiBase}/asset?path=${encodeURIComponent(path)}`;
}

export function Reader({ ref, document, request, navigate, onReload, onActivity, bookmarkState, mediaDimensions }) {
  const root = useRef(null);
  const active = useContext(SessionActivity);
  const session = useReaderSession({ document, root, request, onActivity });
  useImperativeHandle(ref, () => session.actions);
  const prepared = useMemo(() => document.type === 'markdown' && typeof document.html === 'string'
    ? prepareMarkdown(document, documentLink) : null, [document]);
  const assetVersions = useReaderWatch(document, prepared?.assets || [], active, onReload);
  const onExpired = useExpiredPages(onReload);
  return <ReaderContext value={{ document, viewport: session.viewport, prepared, assetVersions, navigate, onExpired, mediaDimensions }}>
    <div ref={root} className="reader" onClick={session.click}>
      {!session.ready ? <div className="status">Loading reading position…</div>
        : session.view === 'raw' ? <RawView document={document} targetLine={session.targetLine} navigationRequest={request} bookmarkState={bookmarkState} />
          : document.type === 'markdown' && !prepared ? <div className="status">Loading preview…</div> : <Preview />}
    </div>
  </ReaderContext>;
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
