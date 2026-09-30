export function createNeovimBridge({ getSessionId = () => undefined,
  output = process.stdout, errors = process.stderr } = {}) {
  const callbacks = new Map();

  function emit(value) {
    const body = JSON.stringify(value);
    const sessionId = getSessionId();
    const callback = callbacks.get(sessionId);
    if (!callback?.url) { output.write(`${body}\n`); return; }
    const target = callback.url;
    callback.tail = callback.tail.then(async () => {
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!response.ok) throw new Error(`Neovim callback returned HTTP ${response.status}`);
    }).catch(error => {
      if (callbacks.get(sessionId) === callback && callback.url === target) callback.url = null;
      errors.write(`Preview callback: ${error.message}\n`);
    });
  }

  function setCallback(sessionId, url) {
    let callback = callbacks.get(sessionId);
    if (!callback) { callback = { url: null, tail: Promise.resolve() }; callbacks.set(sessionId, callback); }
    callback.url = url;
  }
  function detach(sessionId) {
    const callback = callbacks.get(sessionId);
    if (callback) callback.url = null;
    callbacks.delete(sessionId);
  }
  function connected(sessionId = getSessionId()) { return Boolean(callbacks.get(sessionId)?.url); }
  return { emit, setCallback, detach, connected };
}
