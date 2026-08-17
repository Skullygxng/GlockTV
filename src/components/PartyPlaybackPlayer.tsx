import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Maximize, Minimize, Pause, Play, RotateCcw, Server, Volume2 } from 'lucide-react';
import { imageUrl } from '../lib/media';
import type { PartyRoom, PlaybackState } from '../lib/watchParty';
import { buildPlaybackUrl, getPlaybackServers, type PlaybackConfig } from '../lib/playback';
import '../party-player.css';

export interface PartyPlaybackConfig extends PlaybackConfig { movieUrlTemplate: string; tvUrlTemplate: string }

type PlayerEventName = 'ready' | 'play' | 'pause' | 'seeked' | 'timeupdate' | 'ended';
export interface PartyPlayerEvent { event: PlayerEventName; currentTime: number }

const replaceTokens = (template: string, room: PartyRoom) => template
  .replaceAll('{tmdb_id}', String(room.titleId))
  .replaceAll('{season_number}', String(room.seasonNumber ?? 1))
  .replaceAll('{episode_number}', String(room.episodeNumber ?? 1));

export function buildPartyPlaybackUrl(room: PartyRoom, config: PartyPlaybackConfig, serverId?: string, startAt?: number) {
  if (!config.servers?.length) {
    const template = room.mediaType === 'movie' ? config.movieUrlTemplate : config.tvUrlTemplate;
    return template ? replaceTokens(template, room) : '';
  }
  const url = buildPlaybackUrl({ id: room.titleId, mediaType: room.mediaType }, config, {
    season: room.seasonNumber, episode: room.episodeNumber, startAt,
  }, serverId) ?? '';
  if (!url || startAt === undefined) return url;
  try {
    const playback = new URL(url);
    playback.searchParams.set('autoPlay', String(room.playbackState === 'playing'));
    return playback.toString();
  } catch {
    return url;
  }
}

export function getPartyPlaybackConfig(): PartyPlaybackConfig {
  const legacyMovie = import.meta.env.VITE_PARTY_MOVIE_EMBED_URL_TEMPLATE ?? '';
  const legacyTv = import.meta.env.VITE_PARTY_TV_EMBED_URL_TEMPLATE ?? '';
  const autoMovie = import.meta.env.VITE_PARTY_BACKUP_MOVIE_EMBED_URL_TEMPLATE ?? '';
  const autoTv = import.meta.env.VITE_PARTY_BACKUP_TV_EMBED_URL_TEMPLATE ?? '';
  const cineSrcMovie = import.meta.env.VITE_CINESRC_MOVIE_EMBED_URL_TEMPLATE ?? '';
  const cineSrcTv = import.meta.env.VITE_CINESRC_TV_EMBED_URL_TEMPLATE ?? '';
  return { movieUrlTemplate: cineSrcMovie, tvUrlTemplate: cineSrcTv, servers: [
    { id: 'cinesrc', label: 'CineSrc Sync', description: 'Documented play, pause and seek controls', movieUrlTemplate: cineSrcMovie, tvUrlTemplate: cineSrcTv, commandMode: 'cinesrc', startTimeParam: 't' },
    { id: 'auto', label: 'Glock Auto', description: 'Automatic source fallback · popup protected', movieUrlTemplate: autoMovie, tvUrlTemplate: autoTv, commandMode: 'none' },
    { id: 'backup', label: 'Backup stream', description: 'Alternate provider when other servers are slow', movieUrlTemplate: legacyMovie, tvUrlTemplate: legacyTv, commandMode: 'vidzen' },
  ] };
}

export function parsePartyPlayerEvent(raw: unknown): PartyPlayerEvent | null {
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object') return null;
    const message = payload as { type?: unknown; event?: unknown; currentTime?: unknown; data?: { event?: unknown; currentTime?: unknown; time?: unknown } };
    const cineSrcEvent = typeof message.type === 'string' && message.type.startsWith('cinesrc:')
      ? message.type.slice('cinesrc:'.length)
      : null;
    const isMPlayer = message.type === 'mplayer';
    const eventName = cineSrcEvent ?? (isMPlayer ? message.event : message.data?.event);
    const eventTime = cineSrcEvent ? message.currentTime : isMPlayer ? message.currentTime : message.data?.currentTime ?? message.data?.time;
    if ((!cineSrcEvent && message.type !== 'PLAYER_EVENT' && !isMPlayer) || !['ready', 'play', 'pause', 'seeked', 'timeupdate', 'ended'].includes(String(eventName))) return null;
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
  const lastPlayerTime = useRef(0);
  const [loaded, setLoaded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [guestUnlocked, setGuestUnlocked] = useState(false);
  const servers = useMemo(() => getPlaybackServers(config), [config]);
  const [serverId, setServerId] = useState(() => servers[0]?.id ?? '');
  const [serverOpen, setServerOpen] = useState(false);
  const activeServer = servers.find((server) => server.id === serverId) ?? servers[0];
  const commandMode = config.servers?.length ? activeServer?.commandMode ?? 'none' : 'vidzen';
  const startAt = commandMode === 'none' ? roomPosition(room) : undefined;
  const playbackUrl = useMemo(() => buildPartyPlaybackUrl(room, config, serverId, startAt), [config, room.episodeNumber, room.mediaType, room.playbackPosition, room.playbackUpdatedAt, room.seasonNumber, room.titleId, serverId]);
  const shouldMountPlayer = room.isOfficial || room.playbackState === 'playing';
  const send = (command: string, values: Record<string, unknown> = {}) => {
    const receiver = iframe.current?.contentWindow;
    if (commandMode === 'cinesrc') {
      const mapped = command === 'mute' ? 'setMuted' : command === 'volume' ? 'setVolume' : command;
      const args = command === 'seek'
        ? [Number(values.time ?? 0)]
        : command === 'mute'
          ? [Boolean(values.muted)]
          : command === 'volume'
            ? [Number(values.level ?? 1)]
            : [];
      receiver?.postMessage({ type: 'cinesrc:command', command: mapped, args }, 'https://cinesrc.st');
      return;
    }
    if (commandMode !== 'vidzen') return;
    // VidZen documents wildcard delivery because its player can hand playback to a
    // different origin. The message contains commands only, and the receiver is
    // still the exact iframe window rather than an arbitrary browsing context.
    const payload = { command, ...values };
    receiver?.postMessage(buildPartyPlayerCommand(command, values), '*');
    // Some VidZen source handoffs expose the same API but accept the structured
    // clone rather than the serialized envelope advertised by the landing page.
    receiver?.postMessage(payload, '*');
  };

  const syncPlayer = () => {
    const position = roomPosition(room);
    send('seek', { time: position });
    send(room.playbackState === 'playing' ? 'play' : 'pause');
  };

  useEffect(() => {
    if (!shouldMountPlayer) setLoaded(false);
  }, [shouldMountPlayer]);

  useEffect(() => {
    if (!loaded) return;
    syncPlayer();
    const retries = [450, 2000, 5000].map((delay) => window.setTimeout(syncPlayer, delay));
    return () => retries.forEach((timer) => window.clearTimeout(timer));
  }, [commandMode, loaded, room.playbackPosition, room.playbackState, room.playbackUpdatedAt]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      if (commandMode === 'cinesrc' && event.origin !== 'https://cinesrc.st') return;
      const playerEvent = parsePartyPlayerEvent(event.data);
      if (!playerEvent) return;
      if (playerEvent.event === 'ready') { syncPlayer(); return; }
      if (playerEvent.currentTime > 0) lastPlayerTime.current = playerEvent.currentTime;
      if (!isHost || playerEvent.event === 'timeupdate') return;
      const effectiveTime = playerEvent.currentTime || lastPlayerTime.current;
      if (playerEvent.event === 'play' && room.playbackState !== 'playing') onHostCommand('playing', effectiveTime);
      if (playerEvent.event === 'pause' && room.playbackState !== 'paused') onHostCommand('paused', effectiveTime);
      if (playerEvent.event === 'ended') onHostCommand('paused', effectiveTime);
      if (playerEvent.event === 'seeked' && Math.abs(effectiveTime - roomPosition(room)) > 1.5) {
        onHostCommand(room.playbackState, effectiveTime);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commandMode, isHost, onHostCommand, room.playbackState]);

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

  useEffect(() => {
    if (!guestUnlocked) return;
    const retries = [750, 1750, 3500, 6000].map((delay) => window.setTimeout(syncPlayer, delay));
    const timer = window.setTimeout(() => setGuestUnlocked(false), 8000);
    return () => {
      retries.forEach((retry) => window.clearTimeout(retry));
      window.clearTimeout(timer);
    };
  }, [guestUnlocked]);

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

  return <div className={`party-video party-video--full ${isHost ? 'is-host' : 'is-guest'} ${room.isOfficial ? 'is-official' : ''} ${guestUnlocked ? 'is-guest-unlocked' : ''} ${expanded ? 'is-expanded' : ''}`} ref={frame}>
    {shouldMountPlayer
      ? <iframe ref={iframe} key={playbackUrl} title={`${room.titleName} full ${room.mediaType === 'movie' ? 'movie' : 'episode'}`} src={playbackUrl} allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setLoaded(true)} />
      : <div className="party-video__paused" role="status" style={imageUrl(room.backdropPath ?? null, 'w1280') ? { '--paused-backdrop': `url(${imageUrl(room.backdropPath ?? null, 'w1280')})` } as React.CSSProperties : undefined}><span><Pause fill="currentColor" /></span><strong>{isHost ? 'Room paused' : 'Paused by the host'}</strong><small>{isHost ? 'Resume when everyone is ready.' : 'Playback will resume for everyone together.'}</small></div>}
    {!isHost && shouldMountPlayer && <div className="party-video__lock">{room.isOfficial
      ? <span>Tap the player once to join the public timeline</span>
      : guestUnlocked
        ? <span>Tap play in the player · controls lock again shortly</span>
        : <button type="button" aria-label="Enable video playback" onClick={() => setGuestUnlocked(true)}>Enable video · host stays in control</button>}
    </div>}
    <div className="party-server-picker">
      <button type="button" aria-label="Open room server list" aria-expanded={serverOpen} onClick={() => setServerOpen((open) => !open)}><Server /><span>{activeServer?.label ?? 'Server'}</span><ChevronDown /></button>
      {serverOpen && <div role="menu">{servers.map((server) => <button type="button" role="menuitem" key={server.id} className={server.id === serverId ? 'active' : ''} onClick={() => { setServerId(server.id); setServerOpen(false); setLoaded(false); }}><span><strong>{server.label}</strong><small>{server.description}</small></span>{server.id === serverId && <Check />}</button>)}</div>}
    </div>
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
