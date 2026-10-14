import { Worker } from 'node:worker_threads';

export function createWorkerClient({ url, workerData, name, emit = () => {}, profile = () => {}, onStop = () => {}, createTransport = (url, workerData) => new Worker(url, { workerData, execArgv: [] }) }) {
  let worker;
  let sequence = 0;
  const pending = new Map();
  function start() {
    if (worker) return worker;
    const instance = createTransport(url, workerData);
    worker = instance;
    profile(`${name} worker start`, performance.now());
    instance.on('message', message => {
      if (message.event === 'emit') return emit(message.value);
      if (message.event === 'profile') return profile(message.stage, performance.now() - message.ms);
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      if (message.error) task.reject(Object.assign(new Error(message.error), { status: message.status, code: message.code }));
      else task.resolve(message.value);
      if (!pending.size) instance.unref();
    });
    function failed(error) {
      if (worker !== instance) return;
      worker = undefined;
      error.code = 'WORKER_EXIT';
      onStop();
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    }
    instance.on('error', failed);
    instance.on('exit', code => failed(new Error(`${name} worker exited (${code})`)));
    return instance;
  }
  function request(method, args) {
    const instance = start();
    instance.ref();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try { instance.postMessage({ id, method, args }); }
      catch (error) {
        pending.delete(id);
        if (!pending.size) instance.unref();
        reject(error);
      }
    });
  }
  async function stop() {
    const instance = worker;
    if (!instance) return;
    worker = undefined;
    onStop();
    for (const task of pending.values()) task.reject(new Error(`${name} worker stopped`));
    pending.clear();
    await instance.terminate();
    profile(`${name} worker stop`, performance.now());
  }
  return { request, stop, get running() { return Boolean(worker); } };
}
