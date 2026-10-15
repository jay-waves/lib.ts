import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { getDocument, type DocumentView, type LibraryDocument } from './api/documents.ts';
import { loadPosition, readingKey } from './reading-state.mjs';

interface DocumentOptions {
  apiBase: string;
  pageBase: string;
  path: string;
  active: boolean;
  treeReady: boolean;
  treeLoading: boolean;
  node?: { path: string; type: 'directory' | 'file' };
  revision: number;
  theme: string;
  view: DocumentView;
  request?: { path: string; view?: DocumentView | null } | null;
  capture: () => void;
  onOpen: (view: DocumentView) => void;
}

function hasContent(document: LibraryDocument, view: DocumentView | null) {
  if (view === 'raw') return true;
  if (document.type === 'markdown') return document.html !== undefined;
  if (document.type === 'typst') return document.compile !== null;
  return true;
}

function sameContent(previous: LibraryDocument, next: LibraryDocument) {
  // Text responses have no revision; compare their source explicitly.
  if (previous.type === 'text' || next.type === 'text') {
    return previous.type === 'text' && next.type === 'text' && previous.path === next.path
      && previous.absolutePath === next.absolutePath && previous.name === next.name
      && previous.source === next.source;
  }
  return previous.path === next.path && previous.type === next.type
    && previous.modified === next.modified
    && (previous.type !== 'typst' || next.type !== 'typst' || previous.compile?.id === next.compile?.id)
    && (previous.type !== 'markdown' || next.type !== 'markdown' || previous.html === next.html);
}

export function useDocument(options: DocumentOptions) {
  const { apiBase, pageBase, path, active, treeReady, treeLoading, node, revision, theme, request } = options;
  const [document, setDocument] = useState<LibraryDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadedRequest = useRef<string | null>(null);
  const capture = useEffectEvent(options.capture);
  const onOpen = useEffectEvent(options.onOpen);
  const view = document?.path === path
    ? document.type === 'text' ? 'raw' : document.type === 'binary' ? 'preview' : options.view
    : request?.path === path ? request.view ?? null : null;
  const nodePath = node?.path, nodeType = node?.type;
  const waitingForTree = Boolean(path && !node && treeLoading);

  useEffect(() => {
    if (!active || !apiBase) {
      loadedRequest.current = null;
      setDocument(null); setLoading(false); setError('');
      return;
    }
    if (!treeReady) return;
    if (waitingForTree) {
      setLoading(true); setDocument(null); setError('');
      return;
    }
    // Direct links and search results may refer to files omitted from the tree.
    if (!path || nodeType === 'directory') {
      setDocument(null); setLoading(false); setError('');
      return;
    }
    const key = JSON.stringify([apiBase, path, nodePath, nodeType, revision, theme]);
    if (loadedRequest.current === key && document?.path === path && hasContent(document, view)) {
      setLoading(false); setError('');
      return;
    }
    const controller = new AbortController();
    if (document?.path === path && document.type === 'typst') capture();
    setLoading(true); setError('');
    if (document?.path !== path) setDocument(null);
    async function load() {
      const savedView = view || (await loadPosition(readingKey(pageBase, path), apiBase, path)).view;
      const fetchedView: DocumentView = savedView === 'raw' ? 'raw' : 'preview';
      controller.signal.throwIfAborted();
      const value = await getDocument(apiBase, path, fetchedView, theme, controller.signal);
      if (controller.signal.aborted) return;
      loadedRequest.current = key;
      if (document && sameContent(document, value)) return;
      if (document?.path !== value.path) onOpen(fetchedView);
      setDocument(value);
    }
    void load().catch(cause => {
      if (!controller.signal.aborted) setError(String(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
    // Document updates are results, rather than new request triggers.
  }, [apiBase, pageBase, active, treeReady, path, nodePath, nodeType, revision, view, theme, waitingForTree]);
  return { document, loading, error, setError };
}
