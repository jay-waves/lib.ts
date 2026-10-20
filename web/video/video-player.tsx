import { Container, FullscreenButton, Menu, PlayButton, Time, TimeSlider, VolumePopover, VolumeSlider } from '@videojs/react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Video, VideoPlayer, usePlayer } from '@videojs/react/video';
import { TriangleIcon, PauseIcon, ScreenFullIcon, ScreenNormalIcon, MuteIcon, UnmuteIcon } from '@primer/octicons-react';
import { VideoInteractions } from './video-interactions';
import { playbackRates, formatPlaybackRate } from './video-playback';
import './video-player.css';

interface VideoPlayerProps {
  src: string;
  poster: string;
  name: string;
  dimensions?: { width: number; height: number };
  onDimensions(width: number, height: number): void;
  onError(): void;
}

function VolumeControl() {
  const silent = usePlayer(state => state.muted || state.volume === 0);
  return <VolumePopover.Root side="top" openOnHover={false}>
    <VolumePopover.Trigger className="ui-icon-button" aria-label="Volume">
      {silent ? <MuteIcon size={16} /> : <UnmuteIcon size={16} />}
    </VolumePopover.Trigger>
    <VolumePopover.Popup className="video-popup px-[5px] py-3">
      <VolumeSlider.Root orientation="vertical" className="video-slider library-video-volume h-22 w-6 justify-center">
        <VolumeSlider.Track className="video-track h-full w-0.5"><VolumeSlider.Fill className="library-video-fill" /></VolumeSlider.Track>
        <VolumeSlider.Thumb className="library-video-thumb ui-focus" />
      </VolumeSlider.Root>
    </VolumePopover.Popup>
  </VolumePopover.Root>;
}

function SpeedControl() {
  const player = usePlayer();
  const rate = usePlayer(state => state.playbackRate);
  const options = [...new Set([...playbackRates, rate])].sort((a, b) => a - b);
  return <Menu.Root side="top" align="end">
    <Menu.Trigger className="ui-icon-button video-speed" aria-label={`Playback speed: ${formatPlaybackRate(rate)}`}>
      {formatPlaybackRate(rate)}
    </Menu.Trigger>
    <Menu.Popup className="video-popup min-w-16">
      <Menu.Content>
        <Menu.RadioGroup value={String(rate)} onValueChange={value => player.setPlaybackRate(Number(value))} aria-label="Playback speed">
          {options.map(value => <Menu.RadioItem key={value} value={String(value)} className="video-speed-option">
            {formatPlaybackRate(value)}
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content>
    </Menu.Popup>
  </Menu.Root>;
}

export default function LibraryVideoPlayer({ src, poster, name, dimensions, onDimensions, onError }: VideoPlayerProps) {
  const [touchControls, setTouchControls] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number>();
  const ratio = aspectRatio ?? (dimensions ? dimensions.width / dimensions.height : undefined);
  const [compact, setCompact] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // Use the rendered video width, including portrait video and fullscreen.
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 420);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return <VideoPlayer>
    <Container className="library-video relative mx-auto block w-fit min-w-0 max-w-full overflow-hidden rounded-ui bg-[var(--library-canvas,var(--color-bg))] font-ui text-ui text-fg focus:outline-none" aria-label={name}
      data-compact={compact ? '' : undefined}
      style={ratio ? { '--video-aspect-ratio': ratio } as CSSProperties : undefined}
      data-touch-controls={touchControls ? '' : undefined}
      onPointerDown={event => { if (event.pointerType !== 'mouse') setTouchControls(true); }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) setTouchControls(false);
      }}>
      <div className="library-video-frame relative w-fit max-w-full" ref={frameRef}>
        <Video className="library-video-media block h-auto max-h-[80vh] min-h-0 w-auto max-w-full cursor-pointer object-contain"
          src={src} poster={poster} playsInline loop preload="metadata"
          onLoadedMetadata={event => {
            const { videoWidth, videoHeight } = event.currentTarget;
            if (videoWidth && videoHeight) setAspectRatio(videoWidth / videoHeight);
            onDimensions(videoWidth, videoHeight);
          }}
          onError={onError} />
        <div className="library-video-controls" role="group" aria-label="Video controls" data-interactive>
          <PlayButton className="ui-icon-button" render={(props, state) => <button {...props}>
            {state.paused || state.ended ? <TriangleIcon size={16} />
              : <PauseIcon size={16} />}
          </button>} />
          <Time.Group className="video-time">
            <Time.Value type="current" /><span className="video-duration" aria-hidden="true"> / </span><Time.Value type="duration" className="video-duration" />
          </Time.Group>
          <TimeSlider.Root className="video-slider video-seek h-6 min-w-8 flex-1">
            <TimeSlider.Track className="video-track h-0.5 w-full">
              <TimeSlider.Buffer className="library-video-buffer" />
              <TimeSlider.Fill className="library-video-fill" />
            </TimeSlider.Track>
            <TimeSlider.Thumb className="library-video-thumb ui-focus" />
          </TimeSlider.Root>
          <VolumeControl />
          {!compact && <SpeedControl />}
          {!compact && <FullscreenButton className="ui-icon-button" render={(props, state) => <button {...props}>
            {state.fullscreen ? <ScreenNormalIcon size={16} /> : <ScreenFullIcon size={16} />}
          </button>} />}
        </div>
      </div>
      <VideoInteractions />
    </Container>
  </VideoPlayer>;
}
