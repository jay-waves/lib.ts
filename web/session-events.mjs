// Native EventSource 'open' events have no data; older servers also used that name.
export function parseDocumentOpenEvent(event) {
  if (typeof event.data !== 'string' || !event.data) return null;
  try {
    const request = JSON.parse(event.data);
    return request && typeof request === 'object' && typeof request.url === 'string'
      && typeof request.repo === 'string' ? request : null;
  } catch { return null; }
}
