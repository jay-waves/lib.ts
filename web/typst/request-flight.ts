interface Flight<T> {
  controller: AbortController;
  users: number;
  promise: Promise<T>;
}

// Each caller owns its cancellation. Shared work is cancelled only when its
// last subscriber leaves; a subsequent caller can immediately start a new job.
export function requestFlight<T>(
  pending: Map<string, Flight<T>>,
  key: string,
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let flight = pending.get(key);
  if (!flight) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).finally(() => { if (pending.get(key) === flight) pending.delete(key); });
    flight = { controller, users: 0, promise };
    pending.set(key, flight);
  }
  flight.users++;
  if (!signal) return flight.promise;
  const current = flight;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', abort);
      current.users--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      reject(signal.reason);
      if (!current.users) {
        if (pending.get(key) === current) pending.delete(key);
        current.controller.abort();
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    current.promise.then(
      value => { if (finish()) resolve(value); },
      error => { if (finish()) reject(error); },
    );
  });
}
