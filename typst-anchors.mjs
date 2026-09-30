// Insert anchors only at top-level blank lines. Keeping the line count intact
// means compiler diagnostics still refer to the original source lines.
export function anchorSource(source) {
  const lines = source.split('\n');
  const positions = new Map();
  let depth = 0, blockComment = false, string = false, fence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!depth && !blockComment && !string && /^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!depth && !blockComment && !string && !line.trim() && index > 0 && index < lines.length - 1) {
      const id = `preview-anchor-${index + 1}`;
      positions.set(id, index + 1);
      lines[index] = `#context metadata((id: "${id}", pos: here().position()))`;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const pair = line.slice(i, i + 2);
      if (blockComment) { if (pair === '*/') { blockComment = false; i++; } continue; }
      if (string) { if (line[i] === '\\') i++; else if (line[i] === '"') string = false; continue; }
      if (pair === '//') break;
      if (pair === '/*') { blockComment = true; i++; continue; }
      if (line[i] === '"') string = true;
      else if ('([{'.includes(line[i])) depth++;
      else if (')]}'.includes(line[i])) depth = Math.max(0, depth - 1);
    }
  }
  return { text: lines.join('\n'), positions };
}

export function anchorTable(values, positions, sizes) {
  const offsets = [0];
  for (const size of sizes) offsets.push(offsets.at(-1) + size.height);
  return values.flatMap(({ value }) => {
    const line = positions.get(value?.id);
    const page = value?.pos?.page;
    const y = Number.parseFloat(value?.pos?.y);
    if (!line || !Number.isInteger(page) || !sizes[page - 1] || !Number.isFinite(y)) return [];
    return [{ line, page, y, absoluteY: offsets[page - 1] + y }];
  }).sort((a, b) => a.line - b.line);
}

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
