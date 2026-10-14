import { serveWorker } from '../worker-host.mjs';
import { createTypstEngine } from './engine.mjs';

const options = JSON.parse(process.argv[2]);
const port = { on: (event, callback) => process.on(event, callback),
  postMessage: message => { if (process.connected) process.send(message); } };
process.on('disconnect', () => process.exit(0));
const engine = createTypstEngine({ ...options,
  memorySample(stage, details = {}) {
    if (process.env.TYPST_MEMORY !== '1' && process.env.TYPST_WASM_MEMORY !== '1') return;
    const memory = process.memoryUsage();
    const mib = bytes => Math.round(bytes / 1048576 * 10) / 10;
    port.postMessage({ event: 'emit', value: { event: 'memory', stage, pid: process.pid,
      rssMiB: mib(memory.rss), heapMiB: mib(memory.heapUsed), externalMiB: mib(memory.external),
      arrayBuffersMiB: mib(memory.arrayBuffers), ...details } });
  },
  profile: (stage, start) => {
    port.postMessage({ event: 'profile', stage, ms: performance.now() - start });
    if (process.env.TYPST_MEMORY === '1' || process.env.TYPST_WASM_MEMORY === '1')
      port.postMessage({ event: 'emit', value: { event: 'memory', stage, pid: process.pid,
        rssMiB: process.memoryUsage.rss() / 1048576 } });
  },
});
serveWorker(engine, { port });
