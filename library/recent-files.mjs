// All sessions share one queue: an old load cannot overwrite a newer visit or clear.
export function createRecentFilesClient(endpoint, fetcher = (...args) => fetch(...args)) {
  let pending = Promise.resolve(), items = [], visitedAt = {};
  const listeners = new Set();
  function request(method = 'GET', path) {
    const operation = pending.catch(() => {}).then(async () => {
      const response = await fetcher(endpoint, method === 'GET' ? {} : {
        method, keepalive: method === 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(path === undefined ? {} : { path }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Could not load recent files');
      items = value.recent; visitedAt = value.visitedAt || {};
      for (const listener of listeners) listener(items, visitedAt);
      return items;
    });
    pending = operation;
    return operation;
  }
  return {
    subscribe(listener) { listeners.add(listener); listener(items, visitedAt); return () => listeners.delete(listener); },
    load: () => request(), visit: path => request('POST', path), clear: () => request('DELETE'),
  };
}
