// Each caller owns its cancellation. Shared work is cancelled only when its
// last subscriber leaves; a subsequent caller can immediately start a new job.
export function requestFlight(pending, key, work, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let flight = pending.get(key);
  if (!flight) {
    const controller = new AbortController();
    flight = { controller, users: 0 };
    flight.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).finally(() => { if (pending.get(key) === flight) pending.delete(key); });
    pending.set(key, flight);
  }
  flight.users++;
  if (!signal) return flight.promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      flight.users--;
      callback(value);
    };
    const abort = () => {
      finish(reject, signal.reason);
      if (!flight.users) {
        if (pending.get(key) === flight) pending.delete(key);
        flight.controller.abort();
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    flight.promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}
