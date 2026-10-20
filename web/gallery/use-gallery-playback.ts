import { useEffect, useRef, useState } from 'react';
import { createGalleryPlaybackQueue, createGalleryPreviewCache, startGalleryPlayback } from './gallery-playback.mjs';

interface PlaybackOptions {
  src: string;
  playable: boolean;
  autoplay: boolean;
  dimensions?: { width: number; height: number };
  queue: ReturnType<typeof createGalleryPlaybackQueue>;
  cache: ReturnType<typeof createGalleryPreviewCache>;
}

// The card keeps one video element. Viewport, pointer and focus only change its
// scheduling request; cache eviction is the sole offscreen source-unload path.
export function useGalleryPlayback({ src, playable, autoplay, dimensions, queue, cache }: PlaybackOptions) {
  const card = useRef<HTMLAnchorElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState(false);
  const autoplayRef = useRef(autoplay);
  const actions = useRef<{ update(): void; hover(value: boolean): void; focus(value: boolean): void } | null>(null);
  const width = dimensions?.width, height = dimensions?.height;

  useEffect(() => {
    const element = player.current, target = card.current;
    if (!playable || !element || !target) return;
    let visible = false, hovered = false, focused = false;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let unloadTimer: ReturnType<typeof setTimeout> | undefined;
    setReady(false); setError(false); setQueued(false);
    const control = startGalleryPlayback(element, src, {
      queue, enabled: false, dimensions: width && height ? { width, height } : undefined,
      onReady: setReady,
      onQueued: value => { setQueued(value); if (value) setError(false); },
      onError: () => setError(true),
    });
    const unload = () => {
      cache.forget(src);
      clearTimeout(unloadTimer);
      control.unload();
    };
    const update = () => {
      const priority = hovered || focused;
      const enabled = visible && (autoplayRef.current || priority);
      // Disable first when leaving so priority changes cannot briefly restart it.
      if (!enabled) control.setEnabled(false);
      control.setPriority(priority);
      if (enabled) {
        clearTimeout(unloadTimer);
        cache.forget(src);
        control.setEnabled(true);
      } else if (element.getAttribute('src')) cache.retain(src, unload);
    };
    actions.current = {
      update,
      hover(value) {
        clearTimeout(hoverTimer);
        if (value) hoverTimer = setTimeout(() => { hovered = true; update(); }, 150);
        else { hovered = false; update(); }
      },
      focus(value) { focused = value; update(); },
    };
    const root = target.closest('.main-panel');
    const viewport = new IntersectionObserver(([entry]) => {
      if (document.hidden) return;
      visible = entry.isIntersecting && entry.intersectionRatio > 0;
      update();
    }, { root, rootMargin: '120px 0px', threshold: [0, 0.01] });
    const retention = new IntersectionObserver(([entry]) => {
      if (document.hidden) return;
      clearTimeout(unloadTimer);
      if (!entry.isIntersecting) unloadTimer = setTimeout(() => {
        if (!document.hidden && !visible) unload();
      }, 5000);
    }, { root, rootMargin: '800px 0px' });
    viewport.observe(target);
    retention.observe(target);
    return () => {
      actions.current = null;
      viewport.disconnect(); retention.disconnect();
      clearTimeout(hoverTimer); clearTimeout(unloadTimer);
      cache.forget(src);
      control();
    };
  }, [src, playable, width, height, queue, cache]);

  useEffect(() => {
    autoplayRef.current = autoplay;
    actions.current?.update();
  }, [autoplay]);

  return {
    card, player, ready, queued, error,
    onMouseEnter: () => actions.current?.hover(true),
    onMouseLeave: () => actions.current?.hover(false),
    onFocus: () => actions.current?.focus(true),
    onBlur: () => actions.current?.focus(false),
  };
}
