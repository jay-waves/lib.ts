import { bindZoomInput } from '../zoom-input.mjs';
import { galleryColumns, galleryRowTracks } from './gallery-layout.mjs';

export const gallerySize = { min: 140, max: 420, step: 20, initial: 220 };
export function resizeGallery(size, direction, reset, width = 0, rows = true, ratios = []) {
  if (reset) return gallerySize.initial;
  const step = Math.sign(direction) * gallerySize.step;
  if (!step) return size;
  const columns = galleryColumns(width, size);
  const photos = ratios.map(ratio => ({ src: '', width: Math.max(1, Math.round(ratio * 1000)), height: 1000 }));
  const rowKey = size => galleryRowTracks(photos, width, size).map(track => track.photos.length).join(',');
  const currentRows = rows && photos.length && width > 0 ? rowKey(size) : undefined;
  for (let next = Math.round(size / gallerySize.step) * gallerySize.step + step;
    next >= gallerySize.min && next <= gallerySize.max; next += step) {
    if (rows ? currentRows === undefined || rowKey(next) !== currentRows
      : width <= 0 || columns === 1 || galleryColumns(width, next) !== columns) return next;
  }
  return size;
}

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
