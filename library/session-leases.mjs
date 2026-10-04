// Heartbeats protect browser documents without opening one SSE stream per tab.
// Expiry releases resources even if a browser crashes before sending pagehide.
export function createSessionLeases(onViewerChange, { now = Date.now, ttl = 90000 } = {}) {
  const clients = new Map();
  function release(entry) { for (const file of entry.files) onViewerChange(file, false); }
  return {
    update(client, files, version) {
      const previous = clients.get(client);
      if (version !== undefined && previous?.version !== undefined && version <= previous.version) return;
      const next = new Set(files);
      for (const file of previous?.files || []) if (!next.has(file)) onViewerChange(file, false);
      for (const file of next) if (!previous?.files.has(file)) onViewerChange(file, true);
      if (next.size || version !== undefined) clients.set(client, { files: next, expires: now() + ttl, version });
      else clients.delete(client);
    },
    sweep() {
      for (const [client, entry] of clients) if (entry.expires <= now()) { release(entry); clients.delete(client); }
    },
  };
}
