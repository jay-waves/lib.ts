// Dynamic imports already share module loading, including the player's CSS.
export function loadVideoPlayer() {
  return import('./video-player');
}

export function preloadVideoPlayer() {
  // Best effort: a failed warm-up must not break gallery browsing. The real
  // preview can retry through loadVideoPlayer when the user opens a video.
  void loadVideoPlayer().catch(() => {});
}
