import { useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTheme } from '@primer/react/next';
import { SessionActivity } from './session-activity';
import { apiBase, pageBase, fileUrl } from './urls.mjs';
import { useDocumentInfo } from './use-document-info';
import { useDocument } from './use-document';
import { useMediaInfo } from './media/use-media-info';
import { useMediaDimensions } from './media/use-media-dimensions';
import { useDocumentLease } from './use-document-lease';
import { useReaderWatch } from './reader-watch.jsx';
import { DocumentToolbar } from './document-toolbar';
import { DocumentLoading } from './document-loading';
import { DirectoryView } from './directory-view';
import { Reader } from './reader.jsx';
import { useToolbarStuck } from './file-toolbar';
import { documentSymbols } from './symbols/symbols-panel';
import { prepareMarkdown } from './markdown/markdown.mjs';
import { hasDocumentViewport } from './preview-kind.mjs';

export function LibraryError({ error, path, navigate }) {
  const detail = error instanceof Error ? error.message : String(error);
  const missing = /not found|does not exist|enoent/i.test(detail);
  const parent = path.split('/').slice(0, -1).join('/');
  return <section className="status error library-error" role="alert"><div>
    <h2>{missing ? 'File not found' : 'Could not load this content'}</h2>
    <p>{missing ? <>This file may have been moved, renamed, or deleted. <a className="error-inline-link" href={fileUrl(parent, true)}
      onClick={event => { event.preventDefault(); navigate(parent, true); }}>Return to the parent folder</a>.</>
      : 'The library could not load the requested content. The technical details are available below.'}</p>
    <code className="error-path">{path}</code>
    <details className="error-details"><summary>Technical details</summary><pre>{detail}</pre></details>
  </div></section>;
}

// App owns navigation; this keyed page owns the file's data and reader lifecycle.
export function FilePage({ ref, path, request, externalRevision, visible, directory, treeError,
  navigate, display, onDisplayChange, bookmarkState, sidebarToggle, onState }) {
  const active = useContext(SessionActivity);
  const { colorScheme: theme } = useTheme();
  const reader = useRef(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision(value => value + 1);
  const { info, confirmed, ready, error: infoError } = useDocumentInfo(apiBase, path, active, revision + externalRevision);
  const content = useDocument({ apiBase, pageBase, info, active: active && ready,
    revision: revision + externalRevision, theme, request, refreshInfo: reload, capture: () => reader.current?.capture?.() });
  const mediaInfo = useMediaInfo(apiBase, info, active);
  const dimensions = useMediaDimensions(mediaInfo);
  const document = info?.media ? { ...info, url: `${apiBase}/asset?${new URLSearchParams({ path })}` }
    : content.document;
  const [progress, setProgress] = useState({ line: null, page: null, pending: true });
  const reportProgress = next => setProgress(previous => ({ ...next,
    line: next.pending ? previous.line : next.line ?? null,
    page: next.pending ? previous.page : next.page ?? null }));
  const prepared = useMemo(() => content.document?.type === 'markdown' && typeof content.document.html === 'string'
    ? prepareMarkdown(content.document, fileUrl) : null, [content.document]);
  const assetVersions = useReaderWatch(path, info?.modified, prepared?.assets ?? [], active, reload, info?.type === 'typst');
  useDocumentLease(apiBase, confirmed && info?.type !== 'directory' ? path : null);
  const symbols = useMemo(() => content.document ? documentSymbols(content.document) : [], [content.document]);
  const file = Boolean(info && info.type !== 'directory');
  useEffect(() => {
    onState({ path, symbols, progress, view: content.view, loaded: Boolean(document), file, media: Boolean(info?.media),
      viewport: content.view === 'preview' && hasDocumentViewport(info) });
  }, [path, symbols, progress, content.view, Boolean(document), file, info?.type, onState]);
  useImperativeHandle(ref, () => ({
    capture: () => reader.current?.capture?.(),
    handleKeyDown: event => reader.current?.handleKeyDown?.(event),
  }));
  const { stuck, sentinelRef } = useToolbarStuck(visible && file);
  const error = infoError || content.error;
  const details = content.document?.modified === info?.modified
    ? { ...mediaInfo, type: content.document?.type, lineCount: content.document?.lineCount } : mediaInfo;
  if (info?.type === 'directory') return <>
    {error && <LibraryError error={error} path={path} navigate={navigate} />}
    {directory ? <DirectoryView directory={directory} navigate={navigate} display={display} onDisplayChange={onDisplayChange} />
      : treeError ? <LibraryError error={treeError} path={path} navigate={navigate} /> : <div className="status">Loading directory…</div>}
  </>;
  return <>
    {info && <DocumentToolbar info={details} dimensions={dimensions.dimensions} loaded={Boolean(document)}
      view={content.view} progress={info.media ? undefined : progress} stuck={stuck}
      actions={{ switchView: view => reader.current?.switchView?.(view),
        toTop: () => reader.current?.toTop?.(), fit: () => reader.current?.fit?.() }}
      sentinelRef={sentinelRef} bookmarkState={bookmarkState} sidebarToggle={sidebarToggle} />}
    {!document && !error && (info ? <DocumentLoading info={info} /> : <div className="status" role="status">Loading file information…</div>)}
    {error && (document ? <div className="action-error" role="alert">{error}</div> : <LibraryError error={error} path={path} navigate={navigate} />)}
    {document && <Reader ref={reader} key={document.type} document={document} mediaDimensions={dimensions}
      request={request} bookmarkState={bookmarkState} view={content.view} onViewChange={content.changeView}
      navigate={navigate} onReload={reload} onProgress={reportProgress} prepared={prepared} assetVersions={assetVersions} />}
  </>;
}
