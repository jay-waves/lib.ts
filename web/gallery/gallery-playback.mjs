// Each preview owns its requests and timeout; a stuck decoder cannot retain
// its source indefinitely or interfere with another card's lifecycle.
export const galleryPlaybackBudget = 16;

// Pixel count treats portrait and landscape equally. These are scheduling
// estimates, not guarantees about codec, frame rate or hardware acceleration.
export function galleryPlaybackWeight(dimensions) {
  const width = dimensions?.width, height = dimensions?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 4;
  const pixels = width * height;
  if (pixels <= 1280 * 720) return 1;
  if (pixels <= 1920 * 1080) return 2;
  if (pixels <= 2560 * 1440) return 4;
  if (pixels <= 4096 * 2160) return 8;
  return 16;
}

export function createGalleryPlaybackQueue(limit = galleryPlaybackBudget) {
  const pending = [];
  let running = 0;
  const pump = () => {
    while (pending.length) {
      const index = pending.findIndex(job => running + job.weight <= limit);
      if (index < 0) break;
      const [job] = pending.splice(index, 1);
      job.running = true;
      running += job.weight;
      job.start();
    }
  };
  return {
    request(start, weight = 1) {
      const cost = Number.isFinite(weight) && weight > 0 ? Math.min(limit, Math.ceil(weight)) : limit;
      const job = { start, weight: cost, running: false, cancelled: false };
      pending.push(job);
      pump();
      return () => {
        if (job.cancelled) return;
        job.cancelled = true;
        if (job.running) running -= job.weight;
        else pending.splice(pending.indexOf(job), 1);
        pump();
      };
    },
  };
}

// Retain a bounded number of paused previews, evicting the least recently used.
export function createGalleryPreviewCache(limit = 8) {
  const paused = new Map();
  return {
    retain(key, unload) {
      paused.delete(key);
      paused.set(key, unload);
      while (paused.size > limit) {
        const [oldest, release] = paused.entries().next().value;
        paused.delete(oldest);
        release();
      }
    },
    forget(key) { paused.delete(key); },
  };
}

export function startGalleryPlayback(video, src, { onReady, onError, queue = createGalleryPlaybackQueue(), page = globalThis.document, enabled = true, dimensions }, timers = globalThis) {
  let disposed = false;
  let active = false;
  let failures = 0;
  let timeout;
  let retry;
  let cancelSlot;
  let playRequest = 0;
  let weight = galleryPlaybackWeight(dimensions);
  const clear = () => { timers.clearTimeout(timeout); timeout = undefined; };
  const release = () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
  const pause = () => {
    active = false;
    ++playRequest;
    clear();
    timers.clearTimeout(retry);
    video.pause();
    const cancel = cancelSlot;
    cancelSlot = undefined;
    cancel?.();
  };
  const fail = () => {
    if (disposed || !active || page?.hidden) return;
    pause();
    video.removeAttribute('src');
    video.load();
    onReady(false);
    if (++failures === 1) retry = timers.setTimeout(schedule, 500);
    else onError();
  };
  const watch = () => {
    clear();
    timeout = timers.setTimeout(fail, 60000);
  };
  const ready = () => {
    if (!disposed && active && !page?.hidden) { clear(); onReady(true); }
  };
  const waiting = () => {
    if (!disposed && active && !page?.hidden && timeout === undefined) watch();
  };
  function start() {
    if (disposed || !enabled || page?.hidden) return;
    active = true;
    video.muted = true;
    // Reuse the same element, position and browser buffer on a short return.
    if (!video.getAttribute('src')) video.src = src;
    const request = ++playRequest;
    watch();
    Promise.resolve(video.play()).catch(() => {
      if (!disposed && !page?.hidden && request === playRequest) fail();
    });
  }
  function schedule() {
    if (!disposed && enabled && !page?.hidden && !cancelSlot) cancelSlot = queue.request(start, weight);
  }
  const metadata = () => {
    if (disposed || !video.videoWidth || !video.videoHeight) return;
    const actual = galleryPlaybackWeight({ width: video.videoWidth, height: video.videoHeight });
    if (actual === weight) return;
    weight = actual;
    pause();
    schedule();
  };
  const visibility = () => {
    if (page.hidden) pause();
    else schedule();
  };
  video.addEventListener('playing', ready);
  video.addEventListener('waiting', waiting);
  video.addEventListener('error', fail);
  video.addEventListener('loadedmetadata', metadata);
  page?.addEventListener('visibilitychange', visibility);
  schedule();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pause();
    page?.removeEventListener('visibilitychange', visibility);
    video.removeEventListener('playing', ready);
    video.removeEventListener('waiting', waiting);
    video.removeEventListener('error', fail);
    video.removeEventListener('loadedmetadata', metadata);
    release();
  };
  dispose.setEnabled = value => {
    if (disposed || enabled === value) return;
    enabled = value;
    if (enabled) schedule();
    else pause();
  };
  return dispose;
}
