import { bindZoomInput } from './zoom-input.mjs';

export const gallerySize = { min: 140, max: 420, step: 20, wheelStep: 40, initial: 220 };
export const resizeGallery = (size, direction, reset, step = gallerySize.step) => reset ? gallerySize.initial
  : Math.max(gallerySize.min, Math.min(gallerySize.max, size + direction * step));

/**
 * Debounce each continuous wheel gesture into one thumbnail-size change. Keyboard presses remain discrete and cancel any queued wheel step.
 * @param {HTMLElement} viewport
 * @param {(direction: number, reset: boolean, source: 'wheel' | 'key') => void} onStep
 * @param {{delay?: number, threshold?: number, isEnabled?: () => boolean}} options
 */
export function bindGalleryZoom(viewport, onStep, { delay = 80, threshold = 60, isEnabled = () => true } = {}) {
  let timer, delta = 0;
  const clear = () => { clearTimeout(timer); timer = undefined; delta = 0; };
  const unbind = bindZoomInput(viewport, {
    isEnabled,
    wheel: event => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const next = -event.deltaY * unit;
      if (!next) return;
      if (Math.sign(next) !== Math.sign(delta)) delta = 0;
      delta += next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const direction = Math.abs(delta) >= threshold ? Math.sign(delta) : 0;
        clear();
        if (isEnabled() && direction) onStep(direction, false, 'wheel');
      }, delay);
    },
    key: (direction, reset) => { clear(); onStep(direction, reset, 'key'); },
  });
  return () => { clear(); unbind(); };
}
