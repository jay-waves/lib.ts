import { workerData } from 'node:worker_threads';

// Measure the production worker; memory requests use a separate port.
await import('../server/markdown/worker.mjs');
workerData.metrics.on('message', () => workerData.metrics.postMessage(process.memoryUsage()));
