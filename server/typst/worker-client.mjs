import { fork } from 'node:child_process';
import { createWorkerClient } from '../worker-client.mjs';

// This native addon crashes on repeated worker_threads teardown on Windows.
// A child process gives native caches and threads a complete OS lifetime.
function createProcess(url, workerData) {
  const child = fork(url, [JSON.stringify(workerData)], {
    execArgv: [], serialization: 'advanced', windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.postMessage = message => {
    if (!child.connected) throw new Error('Typst process disconnected');
    child.send(message, error => { if (error) child.emit('error', error); });
  };
  const ref = child.ref.bind(child), unref = child.unref.bind(child);
  child.ref = () => { ref(); child.channel?.ref(); };
  child.unref = () => { unref(); child.channel?.unref(); };
  child.terminate = () => new Promise((done, fail) => {
    if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
    child.once('exit', done);
    child.once('error', fail);
    child.kill();
  });
  return child;
}

export function createTypstWorker({ root, artifactMaxBytes, artifactLimit, maxCompilations = 256, ...options }) {
  if (!Number.isInteger(maxCompilations) || maxCompilations < 2)
    throw new Error('Typst maxCompilations must be an integer of at least 2');
  let compilations = 0;
  const worker = createWorkerClient({ ...options, name: 'Typst',
    onStop() { compilations = 0; options.onStop?.(); },
    workerData: { root, artifactMaxBytes, artifactLimit },
    url: new URL('./worker.mjs', import.meta.url), createTransport: createProcess });
  return {
    async request(method, args) {
      // Called within the service's serialized runtime: recycle only before
      // another compile, never between its query/export stages or mid-render.
      if (method === 'compile') {
        if (compilations >= maxCompilations) await worker.stop();
        compilations++;
      }
      return worker.request(method, args);
    },
    stop: worker.stop,
    get running() { return worker.running; },
  };
}
