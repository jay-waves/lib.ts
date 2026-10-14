export const supersededError = () => Object.assign(new Error('Document request superseded by a newer version'),
  { code: 'SUPERSEDED', status: 409 });

// Bytes account for retained inputs of waiting tasks, not engine working memory.
export function createTaskQueue(concurrency, maxPending = 32, maxPendingBytes = 32 * 1024 * 1024) {
  let active = 0, waitingBytes = 0;
  const waiting = [], latest = new Map();
  function remove(task) {
    const index = waiting.indexOf(task);
    if (index < 0) return false;
    waiting.splice(index, 1); waitingBytes -= task.bytes;
    return true;
  }
  function cleanup(task) {
    task.signal?.removeEventListener('abort', task.abort);
    if (latest.get(task.key) === task) latest.delete(task.key);
  }
  function start(task) {
    active++;
    const assertCurrent = () => {
      task.signal?.throwIfAborted();
      if (task.superseded) throw supersededError();
    };
    Promise.resolve().then(() => { assertCurrent(); return task.work({ assertCurrent }); })
      .then(task.resolve, task.reject).finally(() => {
        cleanup(task); active--;
        if (waiting.length) {
          const next = waiting.reduce((best, item) => item.priority > best.priority ? item : best);
          remove(next); start(next);
        }
      });
  }
  const run = (work, { key, bytes = 0, priority = 0, signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    if (!Number.isFinite(bytes) || bytes < 0) { reject(new Error('Invalid task byte size')); return; }
    const previous = key === undefined ? undefined : latest.get(key);
    const replacing = previous && waiting.includes(previous);
    if (active >= concurrency && (waiting.length - (replacing ? 1 : 0) >= maxPending
      || waitingBytes - (replacing ? previous.bytes : 0) + bytes > maxPendingBytes)) {
      reject(Object.assign(new Error('Server is busy. Please retry shortly.'), { status: 503 })); return;
    }
    const task = { work, resolve, reject, key, bytes, priority, signal };
    task.abort = () => {
      if (remove(task)) { cleanup(task); reject(signal.reason); }
    };
    if (previous) {
      previous.superseded = true;
      if (remove(previous)) { cleanup(previous); previous.reject(supersededError()); }
    }
    if (key !== undefined) latest.set(key, task);
    signal?.addEventListener('abort', task.abort, { once: true });
    if (active < concurrency) start(task);
    else { waiting.push(task); waitingBytes += bytes; }
  });
  run.clear = error => {
    for (const task of [...waiting]) { remove(task); cleanup(task); task.reject(error); }
  };
  return run;
}
