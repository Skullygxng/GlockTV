import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minimize, Pause, Play, RotateCcw, Volume2 } from 'lucide-react';
import type { PartyRoom, PlaybackState } from '../lib/watchParty';
import '../party-player.css';

export interface PartyPlaybackConfig {
  movieUrlTemplate: string;
  tvUrlTemplate: string;
}

type PlayerEventName = 'ready' | 'play' | 'pause' | 'seeked' | 'timeupdate' | 'ended';
export interface PartyPlayerEvent { event: PlayerEventName; currentTime: number }

const replaceTokens = (template: string, room: PartyRoom) => template
  .replaceAll('{tmdb_id}', String(room.titleId))
  .replaceAll('{season_number}', String(room.seasonNumber ?? 1))
  .replaceAll('{episode_number}', String(room.episodeNumber ?? 1));

export function buildPartyPlaybackUrl(room: PartyRoom, config: PartyPlaybackConfig) {
  const template = room.mediaType === 'movie' ? config.movieUrlTemplate : config.tvUrlTemplate;
  return template ? replaceTokens(template, room) : '';
}

export function getPartyPlaybackConfig(): PartyPlaybackConfig {
  return {
    movieUrlTemplate: import.meta.env.VITE_PARTY_MOVIE_EMBED_URL_TEMPLATE ?? '',
    tvUrlTemplate: import.meta.env.VITE_PARTY_TV_EMBED_URL_TEMPLATE ?? '',
  };
}

export function parsePartyPlayerEvent(raw: unknown): PartyPlayerEvent | null {
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object') return null;
    const message = payload as { type?: unknown; event?: unknown; currentTime?: unknown; data?: { event?: unknown; currentTime?: unknown; time?: unknown } };
    const isMPlayer = message.type === 'mplayer';
    const eventName = isMPlayer ? message.event : message.data?.event;
    const eventTime = isMPlayer ? message.currentTime : message.data?.currentTime ?? message.data?.time;
    if ((message.type !== 'PLAYER_EVENT' && !isMPlayer) || !['ready', 'play', 'pause', 'seeked', 'timeupdate', 'ended'].includes(String(eventName))) return null;
    const currentTime = Number(eventTime ?? 0);
    return { event: eventName as PlayerEventName, currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0 };
  } catch { return null; }
}

export function buildPartyPlayerCommand(command: string, values: Record<string, unknown> = {}) {
  return JSON.stringify({ command, ...values });
}

function roomPosition(room: PartyRoom) {
  if (room.playbackState === 'paused') return room.playbackPosition;
  const elapsed = Math.max(0, (Date.now() - new Date(room.playbackUpdatedAt).getTime()) / 1000);
  const position = room.playbackPosition + elapsed;
  return room.isOfficial && room.durationSeconds ? position % room.durationSeconds : position;
}

export function PartyPlaybackPlayer({ room, config, isHost, onHostCommand }: { room: PartyRoom; config: PartyPlaybackConfig; isHost: boolean; onHostCommand: (state: PlaybackState, position: number) => void }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const playbackUrl = useMemo(() => buildPartyPlaybackUrl(room, config), [config, room.episodeNumber, room.mediaType, room.seasonNumber, room.titleId]);
  const origin = useMemo(() => { try { return new URL(playbackUrl).origin; } catch { return ''; } }, [playbackUrl]);

  const send = (command: string, values: Record<string, unknown> = {}) => {
    iframe.current?.contentWindow?.postMessage(buildPartyPlayerCommand(command, values), '*');
  };

  const syncPlayer = () => {
    const position = roomPosition(room);
    send('seek', { time: position });
    send(room.playbackState === 'playing' ? 'play' : 'pause');
  };

  useEffect(() => {
    if (!loaded) return;
    syncPlayer();
    const retries = [450, 2000, 5000].map((delay) => window.setTimeout(syncPlayer, delay));
    return () => retries.forEach((timer) => window.clearTimeout(timer));
  }, [loaded, room.playbackPosition, room.playbackState, room.playbackUpdatedAt]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      const playerEvent = parsePartyPlayerEvent(event.data);
      if (!playerEvent) return;
      if (playerEvent.event === 'ready') { syncPlayer(); return; }
      if (!isHost || playerEvent.event === 'timeupdate') return;
      if (playerEvent.event === 'play' && room.playbackState !== 'playing') onHostCommand('playing', playerEvent.currentTime);
      if (playerEvent.event === 'pause' && room.playbackState !== 'paused') onHostCommand('paused', playerEvent.currentTime);
      if (playerEvent.event === 'ended') onHostCommand('paused', playerEvent.currentTime);
      if (playerEvent.event === 'seeked' && Math.abs(playerEvent.currentTime - roomPosition(room)) > 1.5) {
        onHostCommand(room.playbackState, playerEvent.currentTime);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isHost, onHostCommand, origin, room.playbackState]);

  useEffect(() => {
    const update = () => {
      const active = document.fullscreenElement === frame.current;
      setFullscreen(active);
      if (!document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    document.body.classList.toggle('party-fullscreen-open', expanded);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && expanded && !document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('party-fullscreen-open');
    };
  }, [expanded]);

  const toggleFullscreen = async () => {
    if (expanded || document.fullscreenElement) {
      setExpanded(false);
      if (document.fullscreenElement) await document.exitFullscreen?.();
      return;
    }
    setExpanded(true);
    const target = frame.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    try {
      if (target?.requestFullscreen) await target.requestFullscreen();
      else target?.webkitRequestFullscreen?.();
    } catch {
      // The CSS viewport mode remains active on browsers that reject the native API.
    }
  };

  if (!playbackUrl) return <div className="party-player-missing"><strong>Friends playback is not connected</strong><span>Add the authorized party embed templates to the environment.</span></div>;

  return <div className={`party-video party-video--full ${isHost ? 'is-host' : 'is-guest'} ${expanded ? 'is-expanded' : ''}`} ref={frame}>
    <iframe ref={iframe} key={playbackUrl} title={`${room.titleName} full ${room.mediaType === 'movie' ? 'movie' : 'episode'}`} src={playbackUrl} allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setLoaded(true)} />
    {!isHost && <div className="party-video__lock"><span>Host controls playback</span></div>}
    <div className="party-video__toolbar">
      {isHost && <>
        <button type="button" aria-label={room.playbackState === 'playing' ? 'Pause room' : 'Play room'} onClick={() => onHostCommand(room.playbackState === 'playing' ? 'paused' : 'playing', roomPosition(room))}>{room.playbackState === 'playing' ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}</button>
        <button type="button" aria-label="Restart room" onClick={() => onHostCommand('playing', 0)}><RotateCcw /></button>
      </>}
      <button type="button" aria-label="Turn on sound" onClick={() => { send('mute', { muted: false }); send('volume', { level: 1 }); syncPlayer(); }}><Volume2 /></button>
      <button type="button" aria-label={fullscreen || expanded ? 'Exit room fullscreen' : 'Enter room fullscreen'} onClick={() => void toggleFullscreen()}>{fullscreen || expanded ? <Minimize /> : <Maximize />}</button>
    </div>
  </div>;
}
