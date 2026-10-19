export function isSvgDocument(document) {
  return document?.type === 'image' && document.mime === 'image/svg+xml';
}

export function hasDocumentViewport(document) {
  return ['typst', 'pdf', 'image'].includes(document?.type);
}
export function isMediaPreview(document) {
  return document?.type === 'image' || document?.media === 'video';
}
