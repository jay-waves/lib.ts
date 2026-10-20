import { Gesture, Hotkey, useHotkey } from '@videojs/react';
import { usePlayer } from '@videojs/react/video';
import { stepPlaybackRate } from './video-playback';

// Register all input with Video.js so focus, menus, editable fields, modifiers
// and held keys share one policy. Bindings follow mpv's common playback keys.
export function VideoInteractions() {
  const player = usePlayer();
  const rate = usePlayer(state => state.playbackRate);
  useHotkey({ keys: '[', action: 'speedDown', onActivate: () => player.setPlaybackRate(stepPlaybackRate(rate, -1)) });
  useHotkey({ keys: ']', action: 'speedUp', onActivate: () => player.setPlaybackRate(stepPlaybackRate(rate, 1)) });
  useHotkey({ keys: 'Backspace', repeatable: false, onActivate: () => player.setPlaybackRate(1) });
  return <>
    <Gesture type="tap" action="togglePaused" />
    <Hotkey keys="Space" action="togglePaused" />
    <Hotkey keys="p" action="togglePaused" />
    <Hotkey keys="k" action="togglePaused" />
    <Hotkey keys="m" action="toggleMuted" />
    <Hotkey keys="f" action="toggleFullscreen" />
    <Hotkey keys="ArrowLeft" action="seekStep" value={-5} />
    <Hotkey keys="ArrowRight" action="seekStep" value={5} />
    <Hotkey keys="ArrowDown" action="seekStep" value={-60} />
    <Hotkey keys="ArrowUp" action="seekStep" value={60} />
    <Hotkey keys="Shift+ArrowLeft" action="seekStep" value={-1} />
    <Hotkey keys="Shift+ArrowRight" action="seekStep" value={1} />
    <Hotkey keys="Shift+ArrowDown" action="seekStep" value={-5} />
    <Hotkey keys="Shift+ArrowUp" action="seekStep" value={5} />
    <Hotkey keys="9" action="volumeStep" value={-0.02} />
    <Hotkey keys="0" action="volumeStep" value={0.02} />
  </>;
}
