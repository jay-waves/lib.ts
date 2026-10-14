import { createTaskQueue } from './task-queue.mjs';

// Lifecycle and admission control only; document/cache ownership stays in services.
export function createWorkerRuntime({ worker, name, workerIdleMs = 60_000,
  isActive = () => false, concurrency = 1, maxPending = 32, maxPendingBytes = 32 * 1024 * 1024, retries = 1 }) {
  const queue = createTaskQueue(concurrency, maxPending, maxPendingBytes);
  let busy = 0, idleSince, idleTimer, closed = false, closing;
  function assertOpen() {
    if (closed) throw new Error(`${name} service is closed`);
  }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (closed || busy || !worker.running || isActive()) { idleSince = undefined; return; }
    idleSince ??= Date.now();
    idleTimer = setTimeout(() => {
      if (isActive()) scheduleIdle();
      else void worker.stop();
    }, Math.max(0, idleSince + workerIdleMs - Date.now()));
    idleTimer.unref();
  }
  function run(work, options = {}) {
    if (typeof options === 'boolean') options = { touchIdle: options };
    const { touchIdle = true } = options;
    if (closed) return Promise.reject(new Error(`${name} service is closed`));
    busy++;
    if (touchIdle) idleSince = undefined;
    clearTimeout(idleTimer);
    return queue(async context => {
      assertOpen();
      for (let attempt = 0; ; attempt++) {
        try { context.assertCurrent(); return await work(context); }
        catch (error) {
          // Only retry recoverable worker exits. Callers must supply replayable work.
          if (error.code !== 'WORKER_EXIT' || closed || attempt >= retries) throw error;
        }
      }
    }, options).finally(() => { busy--; scheduleIdle(); });
  }
  function close() {
    if (closing) return closing;
    closed = true;
    clearTimeout(idleTimer);
    queue.clear(new Error(`${name} service is closed`));
    return closing = worker.stop();
  }
  return { run, scheduleIdle, assertOpen, close, get closed() { return closed; } };
}

// Share in-flight work only, never results or failures. Accept an existing map
// when its membership also participates in a format's eviction policy.
export function singleFlight(pending, key, work) {
  if (pending.has(key)) return pending.get(key);
  const task = Promise.resolve().then(work).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
