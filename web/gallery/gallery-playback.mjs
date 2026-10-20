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

// Automatic previews share a budget and rotate only when someone is waiting.
// One hovered/focused preview may borrow an extra slot without pausing others.
export const galleryPlaybackTurn = 20000;
export function createGalleryPlaybackQueue(limit = galleryPlaybackBudget, timers = globalThis) {
  const pending = [], running = new Set();
  let used = 0, rotation, extra;
  const release = job => {
    if (!running.delete(job)) return false;
    if (extra === job) extra = undefined;
    else used -= job.weight;
    return true;
  };
  const defer = job => {
    release(job);
    job.suspend?.();
    pending.push(job);
  };
  const grant = (job, borrowed = false) => {
    pending.splice(pending.indexOf(job), 1);
    running.add(job);
    if (borrowed) extra = job;
    else used += job.weight;
    job.ready = false;
    job.start();
  };
  const yieldFor = job => {
    const victims = [...running].filter(other => other !== extra && !other.priority && other.suspend && other.ready);
    if (limit - used + victims.reduce((sum, other) => sum + other.weight, 0) < job.weight) return;
    for (const other of victims) {
      if (used + job.weight <= limit) break;
      defer(other);
    }
    grant(job);
  };
  const pump = () => {
    const urgent = pending.find(job => job.priority);
    if (urgent && (used + urgent.weight <= limit || !extra)) {
      grant(urgent, used + urgent.weight > limit);
    }
    while (pending.length) {
      const index = pending.findIndex(job => used + job.weight <= limit);
      if (index < 0) break;
      grant(pending[index]);
    }
    if (!pending.some(job => !job.priority)) { timers.clearTimeout(rotation); rotation = undefined; }
    else if (rotation === undefined && [...running].some(job => job.suspend)) {
      rotation = timers.setTimeout(() => {
        rotation = undefined;
        const next = pending.find(job => !job.priority);
        if (next) yieldFor(next);
        pump();
      }, galleryPlaybackTurn);
    }
  };
  return {
    request(start, weight = 1, { suspend, priority = false } = {}) {
      const cost = Number.isFinite(weight) && weight > 0 ? Math.min(limit, Math.ceil(weight)) : limit;
      const job = { start, suspend, priority, weight: cost, ready: false, cancelled: false };
      pending.push(job);
      pump();
      const cancel = () => {
        if (job.cancelled) return;
        job.cancelled = true;
        if (!release(job)) pending.splice(pending.indexOf(job), 1);
        pump();
      };
      cancel.setPriority = value => {
        if (job.cancelled || job.priority === value) return;
        job.priority = value;
        if (!value && extra === job) {
          if (used + job.weight <= limit) { extra = undefined; used += job.weight; }
          else defer(job);
        }
        pump();
      };
      cancel.markPlaying = () => { job.ready = true; };
      return cancel;
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

export function startGalleryPlayback(video, src, { onReady, onError, onQueued = (_queued) => {}, queue = createGalleryPlaybackQueue(), page = globalThis.document, enabled = true, priority = false, dimensions }, timers = globalThis) {
  let disposed = false;
  let active = false;
  let failures = 0;
  let timeout;
  let retry;
  let cancelSlot;
  let playRequest = 0;
  let weight = galleryPlaybackWeight(dimensions);
  let bufferedUntil = 0;
  const clear = () => { timers.clearTimeout(timeout); timeout = undefined; };
  const unload = () => {
    if (video.getAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
    bufferedUntil = 0;
    onReady(false);
  };
  const suspend = () => {
    active = false;
    ++playRequest;
    clear();
    timers.clearTimeout(retry);
    video.pause();
  };
  const pause = () => {
    suspend();
    onQueued(false);
    const cancel = cancelSlot;
    cancelSlot = undefined;
    cancel?.();
  };
  const fail = () => {
    if (disposed || !active || page?.hidden) return;
    pause();
    unload();
    if (++failures === 1) retry = timers.setTimeout(schedule, 500);
    else onError();
  };
  const watch = () => {
    clear();
    timeout = timers.setTimeout(fail, 60000);
  };
  const ready = () => {
    if (!disposed && active && !page?.hidden) { clear(); cancelSlot?.markPlaying(); onReady(true); }
  };
  const progress = () => {
    if (!active || page?.hidden || !video.buffered?.length) return;
    const end = video.buffered.end(video.buffered.length - 1);
    if (end > bufferedUntil) {
      bufferedUntil = end;
      if (timeout !== undefined) watch();
    }
  };
  const waiting = () => {
    if (!disposed && active && !page?.hidden && timeout === undefined) watch();
  };
  function start() {
    if (disposed || !enabled || page?.hidden) return;
    active = true;
    onQueued(false);
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
    if (!disposed && failures < 2 && enabled && !page?.hidden && !cancelSlot) {
      onQueued(true);
      cancelSlot = queue.request(start, weight, {
        priority,
        suspend: () => { suspend(); onQueued(true); },
      });
    }
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
  const listeners = { playing: ready, waiting, error: fail, loadedmetadata: metadata, progress };
  for (const [event, listener] of Object.entries(listeners)) video.addEventListener(event, listener);
  page?.addEventListener('visibilitychange', visibility);
  schedule();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    pause();
    page?.removeEventListener('visibilitychange', visibility);
    for (const [event, listener] of Object.entries(listeners)) video.removeEventListener(event, listener);
    unload();
  };
  dispose.setEnabled = value => {
    if (disposed || enabled === value) return;
    enabled = value;
    if (enabled) { failures = 0; schedule(); }
    else pause();
  };
  dispose.setPriority = value => {
    if (disposed || priority === value) return;
    priority = value;
    cancelSlot?.setPriority(value);
    if (value && failures >= 2) { failures = 0; schedule(); }
  };
  dispose.unload = () => {
    if (disposed) return;
    enabled = false;
    pause();
    unload();
  };
  return dispose;
}
