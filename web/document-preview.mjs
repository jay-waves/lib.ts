import { fitDocumentPage } from './document-viewport.mjs';

// Keep small images at their native size and reserve breathing room for large ones.
export function initialImageScale(width, viewportWidth) {
  if (!(width > 0) || !(viewportWidth > 0)) return 1;
  return Math.min(1, viewportWidth * .8 / width);
}

export function pagedDocumentLayout(pages = []) {
  return { pageCount: pages.length, contentWidth: 900, initialFit: fitDocumentPage };
}

export function imageDocumentLayout(size) {
  return {
    pageCount: size ? 1 : 0,
    contentWidth: size?.width || 0,
    initialFit: (width, _height, viewportWidth) => ({
      mode: 'page', scale: initialImageScale(width, viewportWidth),
    }),
  };
}
