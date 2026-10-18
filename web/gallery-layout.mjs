const gap = 12;

// One flat card list keeps React identity stable across size and layout changes.
export function galleryLayout(ratios, availableWidth, size, rows) {
  const width = Math.max(1, availableWidth);
  if (rows) {
    let left = 0, top = 0;
    const items = ratios.map(ratio => {
      const cardWidth = Math.min(width, size * ratio + 2);
      if (left > 0 && left + cardWidth > width) { left = 0; top += size + 2 + gap; }
      const item = { left, top, width: cardWidth, height: size + 2 };
      left += cardWidth + gap;
      return item;
    });
    return { items, height: items.length ? top + size + 2 : 0 };
  }
  const count = Math.max(1, Math.floor((width + gap) / (size + gap)));
  const cardWidth = (width - (count - 1) * gap) / count;
  const heights = Array(count).fill(0);
  const items = ratios.map((ratio, index) => {
    // Loading a dimension only moves later cards in the same column.
    const column = index % count;
    const height = Math.max(0, cardWidth - 2) / ratio + 2;
    const item = { left: column * (cardWidth + gap), top: heights[column], width: cardWidth, height };
    heights[column] += height + gap;
    return item;
  });
  return { items, height: Math.max(0, ...heights) - (items.length ? gap : 0) };
}
