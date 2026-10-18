import type { LibraryDocument } from './api/documents.ts';

// The API schema gives responses a stable field order. Compare the complete
// content, including dependency/render revisions, without format-specific rules.
export function sameDocumentContent(previous: LibraryDocument, next: LibraryDocument) {
  return JSON.stringify(previous) === JSON.stringify(next);
}

export function changedAssetPaths(previous: Record<string, string | null>, next: Record<string, string | null>) {
  return Object.keys(next).filter(path => Object.hasOwn(previous, path) && previous[path] !== next[path]);
}
