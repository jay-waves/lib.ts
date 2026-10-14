import { parentPort } from 'node:worker_threads';

// Serialize mutable engine access, preserving status and transferable results.
export function serveWorker(methods, { port = parentPort, profilePrefix, transfer = () => [] } = {}) {
  let work = Promise.resolve();
  const emit = value => port.postMessage({ event: 'emit', value });
  const profile = (stage, start) => port.postMessage({ event: 'profile', stage, ms: performance.now() - start });
  port.on('message', ({ id, method, args }) => {
    work = work.then(async () => {
      try {
        if (!Object.hasOwn(methods, method) || typeof methods[method] !== 'function')
          throw new Error(`Unknown worker method: ${method}`);
        const start = performance.now();
        const value = await methods[method](args);
        if (profilePrefix) profile(`${profilePrefix} ${method}`, start);
        port.postMessage({ id, value }, transfer(value));
      } catch (error) {
        port.postMessage({ id, error: error.message, status: error.status, code: error.code });
      }
    });
  });
  return { emit, profile };
}
