// Convert between source lines and rendered page positions for browser navigation.
function interpolate(value, entries, key, other) {
  if (!entries.length) return;
  let lower = entries[0], upper = entries.at(-1);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i][key] >= value) { lower = entries[i - 1]; upper = entries[i]; break; }
  }
  if (value <= entries[0][key]) return entries[0][other];
  if (value >= entries.at(-1)[key]) return entries.at(-1)[other];
  const span = upper[key] - lower[key];
  return span ? lower[other] + (value - lower[key]) / span * (upper[other] - lower[other]) : lower[other];
}

export function positionForLine(line, anchors, sizes) {
  const absoluteY = interpolate(line, anchors, 'line', 'absoluteY');
  if (absoluteY === undefined) return;
  let offset = 0;
  for (let index = 0; index < sizes.length; index++) {
    if (absoluteY <= offset + sizes[index].height || index === sizes.length - 1)
      return { page: index + 1, y: Math.max(0, Math.min(1, (absoluteY - offset) / sizes[index].height)) };
    offset += sizes[index].height;
  }
}

export function lineForPosition(page, y, anchors, sizes) {
  if (!Number.isInteger(page) || !sizes[page - 1] || !Number.isFinite(y) || y < 0 || y > 1) return;
  const offset = sizes.slice(0, page - 1).reduce((sum, size) => sum + size.height, 0);
  const sorted = [...anchors].sort((a, b) => a.absoluteY - b.absoluteY);
  const line = interpolate(offset + y * sizes[page - 1].height, sorted, 'absoluteY', 'line');
  return line === undefined ? undefined : Math.round(line);
}
