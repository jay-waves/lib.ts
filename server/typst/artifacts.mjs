// Worker-local: serialized engine calls ensure an artifact is never evicted
// while a renderer is using it. Keep a lone oversized document usable.
export function createArtifactStore({ maxBytes = 64 * 1024 * 1024, maxEntries = 3 } = {}) {
  const entries = new Map();
  let bytes = 0;
  function remove(id) {
    const item = entries.get(id);
    if (!item) return;
    bytes -= item.artifactBytes;
    entries.delete(id);
  }
  return {
    get(id) {
      const item = entries.get(id);
      if (item) { entries.delete(id); entries.set(id, item); }
      return item;
    },
    set(id, item) {
      remove(id); entries.set(id, item); bytes += item.artifactBytes;
      while (entries.size > 1 && (entries.size > maxEntries || bytes > maxBytes)) remove(entries.keys().next().value);
    },
    delete: remove,
    retain(ids) {
      const keep = new Set(ids);
      for (const id of entries.keys()) if (!keep.has(id)) remove(id);
    },
    keys: () => entries.keys(),
    get bytes() { return bytes; },
  };
}
