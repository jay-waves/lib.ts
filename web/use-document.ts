import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { getDocument, type DocumentView, type LibraryDocument } from './api/documents.ts';
import type { FileDescriptor } from './document-info';
import { readerView } from './reader-session.mjs';
import { readPosition, readingKey } from './reading-state.mjs';
import { sameDocumentContent } from './document-content.ts';

interface DocumentOptions {
  apiBase: string;
  pageBase: string;
  info: FileDescriptor | null;
  active: boolean;
  revision: number;
  theme: string;
  request?: { path: string; view?: DocumentView | null } | null;
  capture(): void;
  refreshInfo(): void;
}

function hasContent(document: LibraryDocument, view: DocumentView) {
  if (view === 'raw') return true;
  if (document.type === 'markdown') return document.html !== undefined;
  if (document.type === 'typst') return document.compile !== null;
  return true;
}

export function useDocument({ apiBase, pageBase, info, active, revision, theme, request, capture: onCapture, refreshInfo: onRefreshInfo }: DocumentOptions) {
  const [document, setDocument] = useState<LibraryDocument | null>(null);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState<{ request: DocumentOptions['request']; view: DocumentView } | null>(null);
  const loadedRequest = useRef('');
  const capture = useEffectEvent(onCapture);
  const refreshInfo = useEffectEvent(onRefreshInfo);
  const path = info?.path ?? '';
  const type = info?.type;
  const requestedView = choice && choice.request === request ? choice.view
    : request?.view || (info && !info.media ? readPosition(readingKey(pageBase, path)).view : undefined);
  // Full source validation can identify binary data beyond the inspected header.
  const descriptor = document?.type === 'binary' && document.modified === info?.modified && !info?.media ? document : info;
  const view = readerView(descriptor ?? {}, requestedView) as DocumentView;
  const contentTheme = type === 'typst' ? theme : '';
  const needsContent = Boolean(info && !info.media && type !== 'directory');
  useEffect(() => {
    if (!active || !needsContent) return;
    const key = JSON.stringify([path, type, info?.modified, revision, contentTheme]);
    if (loadedRequest.current === key && document && hasContent(document, view)) return;
    const controller = new AbortController();
    setError('');
    void getDocument(apiBase, path, view, contentTheme, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      // Reconcile only responses that crossed a file change, not old content
      // retained on screen while a newer descriptor is already loading.
      if (value.modified !== info?.modified) refreshInfo();
      loadedRequest.current = key;
      if (!document || !sameDocumentContent(document, value)) {
        capture();
        setDocument(value);
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setError(String(cause));
    });
    return () => controller.abort();
  }, [apiBase, path, type, info?.modified, active, needsContent, revision, view, contentTheme]);
  return { document: needsContent ? document : null, view,
    changeView: (view: DocumentView) => setChoice({ request, view }), error: needsContent ? error : '' };
}
