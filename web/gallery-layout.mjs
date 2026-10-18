import { computeRowsLayout } from 'react-photo-album';

const gap = 12;
export const galleryColumns = (width, size) => Math.max(1, Math.floor((width + gap) / (size + gap)));
/**
 * @template {import('react-photo-album').Photo} TPhoto
 * @param {readonly TPhoto[]} photos
 * @param {number} width
 * @param {number} size
 */
export const galleryRows = (photos, width, size) => computeRowsLayout(photos, gap, 0, width, size);

// One flat card list keeps React identity stable across size and layout changes.
export function galleryLayout(ratios, availableWidth, size) {
  const width = Math.max(1, availableWidth);
  const count = galleryColumns(width, size);
  const cardWidth = (width - (count - 1) * gap) / count;
  const heights = Array(count).fill(0);
  const items = ratios.map((ratio, index) => {
    // Loading a dimension only moves later cards in the same column.
    const column = index % count;
    const naturalHeight = Math.max(0, cardWidth - 2) / ratio;
    // With one column the viewport fixes the card width, so scale its media box
    // to keep the size control meaningful instead of producing inert stops.
    const height = (count === 1 ? naturalHeight * size / 200 : naturalHeight) + 2;
    const item = { left: column * (cardWidth + gap), top: heights[column], width: cardWidth, height };
    heights[column] += height + gap;
    return item;
  });
  return { items, height: Math.max(0, ...heights) - (items.length ? gap : 0) };
}
