import { isGalleryImage, isVideoMedia } from '../gallery/gallery-images.ts';

export function adjacentMediaPath(nodes, path, direction) {
  const media = (nodes ?? []).filter(node => node.type === 'file'
    && (isGalleryImage(node.name) || isVideoMedia(node)));
  const index = media.findIndex(node => node.path === path);
  return index < 0 ? undefined : media[index + direction]?.path;
}

export function mediaNavigationDirection(event) {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return 0;
  if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select, [contenteditable], [role="menu"], [role="menuitem"], [role="menuitemradio"]')) return 0;
  // The video reader owns file navigation even when a player control has focus.
  if (!event.target?.closest?.('.library-video')
    && event.target?.closest?.('button, a[href], [role="button"], [role="slider"]')) return 0;
  // Angle brackets normally require Shift on the keyboard.
  if (event.key === '<') return -1;
  if (event.key === '>') return 1;
  if (event.shiftKey) return 0;
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
}
