// Typst source positions used by compilation and server-side outline generation.
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
