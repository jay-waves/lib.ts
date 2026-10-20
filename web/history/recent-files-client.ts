import { parseJsonResponse } from '../api/client';
import { recentFilesResponseSchema, type RecentFilesResponse } from '../api/contracts';

type Listener = (paths: string[], visitedAt: Record<string, string>) => void;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// All sessions share one queue: an old load cannot overwrite a newer visit or clear.
export function createRecentFilesClient(endpoint: string, fetcher: Fetcher = (...args) => fetch(...args)) {
  let pending: Promise<unknown> = Promise.resolve();
  let items: string[] = [];
  let visitedAt: Record<string, string> = {};
  const listeners = new Set<Listener>();
  function request(method = 'GET', path?: string): Promise<string[]> {
    const operation = pending.catch(() => {}).then(async () => {
      const response = await fetcher(endpoint, method === 'GET' ? {} : {
        method, keepalive: method === 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(path === undefined ? {} : { path }),
      });
      const value: RecentFilesResponse = await parseJsonResponse(response, recentFilesResponseSchema, endpoint);
      items = value.recent; visitedAt = value.visitedAt;
      for (const listener of listeners) listener(items, visitedAt);
      return items;
    });
    pending = operation;
    return operation;
  }
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener(items, visitedAt);
      return () => { listeners.delete(listener); };
    },
    load: () => request(), visit: (path: string) => request('POST', path), clear: () => request('DELETE'),
  };
}
