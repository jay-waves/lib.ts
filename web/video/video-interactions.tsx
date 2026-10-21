import { Gesture, Hotkey, useContainer, useHotkey } from '@videojs/react';
import { useEffect, useEffectEvent } from 'react';
import { usePlayer } from '@videojs/react/video';
import { stepPlaybackRate, videoSeekStep } from './video-playback';

// Register all input with Video.js so focus, menus, editable fields, modifiers
// and held keys share one policy. Bindings follow mpv's common playback keys.
export function VideoInteractions({ active }: { active: boolean }) {
  const player = usePlayer();
  const scope = { target: 'document' as const, disabled: !active };
  const rate = usePlayer(state => state.playbackRate);
  const container = useContainer();
  const seekFromControl = useEffectEvent((event: KeyboardEvent) => {
    if (!active || !(event.target instanceof Element) || !event.target.closest('[role="slider"]')) return;
    const step = videoSeekStep(event);
    if (!step) return;
    // Sliders process arrows in capture before the player's hotkeys. Apply the
    // same seconds-based seek here before their percentage-based handler runs.
    event.preventDefault();
    event.stopPropagation();
    player.seek(player.state.currentTime + step);
  });
  useEffect(() => {
    if (!container) return;
    const keydown = (event: KeyboardEvent) => seekFromControl(event);
    container.addEventListener('keydown', keydown, true);
    return () => container.removeEventListener('keydown', keydown, true);
  }, [container]);
  useHotkey({ ...scope, keys: '[', action: 'speedDown', onActivate: () => player.setPlaybackRate(stepPlaybackRate(rate, -1)) });
  useHotkey({ ...scope, keys: ']', action: 'speedUp', onActivate: () => player.setPlaybackRate(stepPlaybackRate(rate, 1)) });
  useHotkey({ ...scope, keys: 'Backspace', repeatable: false, onActivate: () => player.setPlaybackRate(1) });
  return <>
    <Gesture type="tap" action="togglePaused" />
    {/* Opening a video from the tree leaves focus outside the player. Only
        the visible reader owns the page-wide playback shortcut. */}
    <Hotkey {...scope} keys="Space" action="togglePaused" />
    <Hotkey {...scope} keys="p" action="togglePaused" />
    <Hotkey {...scope} keys="k" action="togglePaused" />
    <Hotkey {...scope} keys="m" action="toggleMuted" />
    <Hotkey {...scope} keys="f" action="toggleFullscreen" />
    <Hotkey {...scope} keys="ArrowLeft" action="seekStep" value={-5} />
    <Hotkey {...scope} keys="ArrowRight" action="seekStep" value={5} />
    <Hotkey {...scope} keys="Shift+ArrowLeft" action="seekStep" value={-1} />
    <Hotkey {...scope} keys="Shift+ArrowRight" action="seekStep" value={1} />
    <Hotkey {...scope} keys="Shift+ArrowDown" action="seekStep" value={-5} />
    <Hotkey {...scope} keys="Shift+ArrowUp" action="seekStep" value={5} />
    <Hotkey {...scope} keys="9" action="volumeStep" value={-0.02} />
    <Hotkey {...scope} keys="0" action="volumeStep" value={0.02} />
  </>;
}
