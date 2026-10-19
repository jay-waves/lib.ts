export const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function formatPlaybackRate(rate: number) {
  return `${Number(rate.toFixed(2))}×`;
}

// mpv's brackets multiply speed by 1.1 and its inverse. Keep browser playback
// within a useful range and avoid accumulating floating-point display noise.
export function stepPlaybackRate(rate: number, direction: -1 | 1) {
  const next = direction === 1 ? rate * 1.1 : rate / 1.1;
  return Math.max(0.25, Math.min(4, Number(next.toFixed(4))));
}
