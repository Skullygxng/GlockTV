import { useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { PartyRoom, PlaybackState } from '../lib/watchParty';

export interface PartyPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  mute(): void;
  getCurrentTime(): number;
  destroy(): void;
}

export type PartyPlayerFactory = (
  element: HTMLDivElement,
  videoId: string,
  onReady: (player: PartyPlayer) => void,
  onStateChange: (state: PlaybackState, position: number) => void,
) => PartyPlayer;

interface RawYouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  getCurrentTime(): number;
  destroy(): void;
}

interface RawYouTubeStateEvent {
  data: number;
  target: RawYouTubePlayer;
}

interface YouTubeNamespace {
  Player: new (element: HTMLDivElement, options: {
    videoId: string;
    playerVars: Record<string, string | number>;
    events: { onReady: () => void; onStateChange: (event: RawYouTubeStateEvent) => void };
  }) => RawYouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let youtubeApiPromise: Promise<YouTubeNamespace> | null = null;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;

  youtubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      if (window.YT) resolve(window.YT);
    };

    const existing = document.querySelector<HTMLScriptElement>('script[data-glocktv-youtube]');
    if (existing) return;
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.dataset.glocktvYoutube = 'true';
    script.onerror = () => reject(new Error('YouTube player could not load.'));
    document.head.appendChild(script);
  });
  return youtubeApiPromise;
}

export const createYouTubePlayer: PartyPlayerFactory = (element, videoId, onReady, onStateChange) => {
  let raw: RawYouTubePlayer | null = null;
  let destroyed = false;
  const controller: PartyPlayer = {
    play: () => raw?.playVideo(),
    pause: () => raw?.pauseVideo(),
    seek: (seconds) => raw?.seekTo(seconds, true),
    mute: () => raw?.mute(),
    getCurrentTime: () => raw?.getCurrentTime() ?? 0,
    destroy: () => { destroyed = true; raw?.destroy(); raw = null; },
  };

  void loadYouTubeApi().then((YT) => {
    if (destroyed) return;
    raw = new YT.Player(element, {
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 1,
        playsinline: 1,
        rel: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: () => onReady(controller),
        onStateChange: (event) => { if (event.data === 1 || event.data === 2) onStateChange(event.data === 1 ? 'playing' : 'paused', event.target.getCurrentTime()); },
      },
    });
  });

  return controller;
};

interface YouTubePartyPlayerProps {
  room: PartyRoom;
  isHost: boolean;
  onHostCommand: (state: PlaybackState, position: number) => void;
  factory?: PartyPlayerFactory;
}

function livePosition(room: PartyRoom) {
  if (room.playbackState === 'paused') return room.playbackPosition;
  const elapsed = Math.max(0, (Date.now() - Date.parse(room.playbackUpdatedAt)) / 1000);
  return room.playbackPosition + elapsed;
}

export function YouTubePartyPlayer({ room, isHost, onHostCommand, factory = createYouTubePlayer }: YouTubePartyPlayerProps) {
  const mount = useRef<HTMLDivElement>(null);
  const player = useRef<PartyPlayer | null>(null);
  const isHostRef = useRef(isHost);
  const commandRef = useRef(onHostCommand);
  isHostRef.current = isHost;
  commandRef.current = onHostCommand;
  const [readyVersion, setReadyVersion] = useState(0);
  const [syncEnabled, setSyncEnabled] = useState(isHost);

  useEffect(() => {
    if (!mount.current) return;
    const created = factory(
      mount.current,
      room.trailerKey,
      (readyPlayer) => { player.current = readyPlayer; setReadyVersion((version) => version + 1); },
      (state, position) => { if (isHostRef.current) commandRef.current(state, position); },
    );
    player.current = created;
    return () => { created.destroy(); player.current = null; };
  }, [factory, room.trailerKey]);

  useEffect(() => {
    if (!readyVersion || !player.current) return;
    if (!isHost && !syncEnabled) return;
    const desired = livePosition(room);
    if (Math.abs(player.current.getCurrentTime() - desired) > 1.5) player.current.seek(desired);
    if (room.playbackState === 'playing') player.current.play();
    else player.current.pause();
  }, [isHost, readyVersion, room.playbackPosition, room.playbackState, room.playbackUpdatedAt, syncEnabled]);

  useEffect(() => {
    if (isHost || !readyVersion || !syncEnabled) return;
    const timer = window.setInterval(() => {
      const desired = livePosition(room);
      if (player.current && Math.abs(player.current.getCurrentTime() - desired) > 1.5) player.current.seek(desired);
      if (room.playbackState === 'playing') player.current?.play();
      else player.current?.pause();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [isHost, readyVersion, room.playbackPosition, room.playbackState, room.playbackUpdatedAt, syncEnabled]);

  const issue = (state: PlaybackState, position?: number) => {
    const current = position ?? player.current?.getCurrentTime() ?? 0;
    if (position !== undefined) player.current?.seek(position);
    if (state === 'playing') player.current?.play();
    else player.current?.pause();
    onHostCommand(state, current);
  };

  const enableGuestSync = () => {
    const desired = livePosition(room);
    player.current?.mute();
    if (player.current && Math.abs(player.current.getCurrentTime() - desired) > 1.5) player.current.seek(desired);
    if (room.playbackState === 'playing') player.current?.play();
    else player.current?.pause();
    setSyncEnabled(true);
  };

  return <>
    <div className="party-video"><div ref={mount} title={`${room.titleName} watch party trailer`} /></div>
    {isHost ? <div className="host-controls" aria-label="Host playback controls">
      <button type="button" aria-label="Play for everyone" onClick={() => issue('playing')}><Play fill="currentColor" /></button>
      <button type="button" aria-label="Pause for everyone" onClick={() => issue('paused')}><Pause fill="currentColor" /></button>
      <button type="button" aria-label="Restart for everyone" onClick={() => issue('playing', 0)}><RotateCcw /> Restart</button>
      <span>You control the room</span>
    </div> : syncEnabled
      ? <p className="guest-note guest-note--synced"><span className="live-dot" /> Synced to the host · unmute in the player</p>
      : <div className="guest-sync-gate">
        <button type="button" aria-label="Join synced playback" onClick={enableGuestSync}><Play fill="currentColor" /> Join synced playback</button>
        <span>Tap once so your browser allows the host to control playback.</span>
      </div>}
  </>;
}
