import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Pause, Server } from 'lucide-react';
import { imageUrl } from '../lib/media';
import type { PartyRoom, PlaybackState } from '../lib/watchParty';
import { buildPlaybackUrl, getPlaybackServers, type PlaybackConfig } from '../lib/playback';
import { PARTY_PLAYBACK_FALLBACK_MS, nextPlaybackServerId, providerAllowsAutomaticFailover } from '../lib/playbackRecovery';
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
  if (!url) return url;
  try {
    const playback = new URL(url);
    const activeServer = getPlaybackServers(config).find((server) => server.id === serverId) ?? getPlaybackServers(config)[0];
    if (activeServer?.commandMode === 'cinesrc') {
      playback.searchParams.set('autoplay', 'false');
      playback.searchParams.set('continueprompt', 'false');
      return playback.toString();
    }
    if (startAt === undefined) return url;
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
    { id: 'auto', label: 'VidCore Backup', description: 'Standard playback fallback \u00b7 limited room sync', movieUrlTemplate: autoMovie, tvUrlTemplate: autoTv, commandMode: 'none' },
    { id: 'backup', label: 'VidZen Backup', description: 'Alternate provider \u00b7 limited room sync', movieUrlTemplate: legacyMovie, tvUrlTemplate: legacyTv, commandMode: 'vidzen' },
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

interface PartyPlaybackPlayerProps {
  room: PartyRoom;
  config: PartyPlaybackConfig;
  isHost: boolean;
  onHostCommand: (state: PlaybackState, position: number) => void;
  onHostServerChange?: (serverId: string) => void;
  onSyncHealth?: (health: { status: 'connecting' | 'synced' | 'drifting' | 'limited'; offsetSeconds: number | null; serverId: string }) => void;
  resyncToken?: number;
}

export function PartyPlaybackPlayer({ room, config, isHost, onHostCommand, onHostServerChange, onSyncHealth, resyncToken = 0 }: PartyPlaybackPlayerProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const lastPlayerTime = useRef(0);
  const lastHealthReport = useRef({ at: 0, status: '', offset: Number.NaN });
  const [loaded, setLoaded] = useState(false);
  const [providerState, setProviderState] = useState<'loading' | 'ready' | 'slow' | 'unavailable'>('loading');
  const attemptedServers = useRef(new Set<string>());
  const [guestActivated, setGuestActivated] = useState(false);
  const [guestUnlocked, setGuestUnlocked] = useState(false);
  const servers = useMemo(() => getPlaybackServers(config), [config]);
  const [serverOverride, setServerOverride] = useState('');
  const [serverOpen, setServerOpen] = useState(false);
  const roomServerId = servers.some((server) => server.id === room.serverId) ? room.serverId : servers[0]?.id ?? '';
  const serverId = !isHost && serverOverride ? serverOverride : roomServerId;
  const activeServer = servers.find((server) => server.id === serverId) ?? servers[0];
  const commandMode = config.servers?.length ? activeServer?.commandMode ?? 'none' : 'vidzen';
  const startAt = commandMode === 'vidzen' ? undefined : roomPosition(room);
  const playbackUrl = useMemo(() => buildPartyPlaybackUrl(room, config, serverId, startAt), [config, room.episodeNumber, room.mediaType, room.playbackPosition, room.playbackUpdatedAt, room.seasonNumber, room.titleId, serverId]);
  const shouldMountPlayer = isHost || room.isOfficial || room.playbackState === 'playing' || (!isHost && guestActivated && commandMode === 'cinesrc');

  useEffect(() => {
    lastPlayerTime.current = 0;
    lastHealthReport.current = { at: 0, status: '', offset: Number.NaN };
    attemptedServers.current = new Set();
    setLoaded(false);
    setProviderState('loading');
  }, [room.episodeNumber, room.mediaType, room.seasonNumber, room.titleId]);

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
    const payload = { command, ...values };
    receiver?.postMessage(buildPartyPlayerCommand(command, values), '*');
    receiver?.postMessage(payload, '*');
  };

  const syncPlayer = () => {
    const position = roomPosition(room);
    send('seek', { time: position });
    send(room.playbackState === 'playing' ? 'play' : 'pause');
  };

  const reportSyncHealth = (currentTime: number) => {
    if (!onSyncHealth) return;
    if (commandMode === 'none') {
      onSyncHealth({ status: 'limited', offsetSeconds: null, serverId });
      return;
    }
    const offsetSeconds = currentTime - roomPosition(room);
    const status = Math.abs(offsetSeconds) <= 2 ? 'synced' : 'drifting';
    const now = Date.now();
    const previous = lastHealthReport.current;
    if (previous.status === status && Math.abs(previous.offset - offsetSeconds) < 1 && now - previous.at < 5000) return;
    lastHealthReport.current = { at: now, status, offset: offsetSeconds };
    onSyncHealth({ status, offsetSeconds, serverId });
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
    if (resyncToken > 0) syncPlayer();
  }, [resyncToken]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      if (commandMode === 'cinesrc' && event.origin !== 'https://cinesrc.st') return;
      const playerEvent = parsePartyPlayerEvent(event.data);
      if (!playerEvent) return;
      setProviderState('ready');
      if (playerEvent.event === 'ready') { syncPlayer(); return; }
      if (playerEvent.currentTime > 0) lastPlayerTime.current = playerEvent.currentTime;
      if (playerEvent.event === 'timeupdate') reportSyncHealth(playerEvent.currentTime);
      if (!isHost) {
        if (!guestActivated || playerEvent.event === 'timeupdate') return;
        const effectiveTime = playerEvent.currentTime || lastPlayerTime.current;
        const guestChangedPlayback = (playerEvent.event === 'pause' && room.playbackState === 'playing')
          || (playerEvent.event === 'play' && room.playbackState === 'paused')
          || (playerEvent.event === 'seeked' && Math.abs(effectiveTime - roomPosition(room)) > 1.5);
        if (guestChangedPlayback) syncPlayer();
        return;
      }
      if (playerEvent.event === 'timeupdate') return;
      const effectiveTime = playerEvent.currentTime || lastPlayerTime.current;
      if (playerEvent.event === 'play' && (room.playbackState !== 'playing' || Math.abs(effectiveTime - roomPosition(room)) > 1.5)) {
        onHostCommand('playing', effectiveTime);
      }
      if (playerEvent.event === 'pause' && room.playbackState !== 'paused') onHostCommand('paused', effectiveTime);
      if (playerEvent.event === 'ended') onHostCommand('paused', effectiveTime);
      if (playerEvent.event === 'seeked' && Math.abs(effectiveTime - roomPosition(room)) > 1.5) {
        onHostCommand(room.playbackState, effectiveTime);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commandMode, guestActivated, isHost, onHostCommand, onSyncHealth, room.playbackPosition, room.playbackState, room.playbackUpdatedAt, serverId]);

  useEffect(() => {
    if (!shouldMountPlayer || providerState === 'ready' || providerState === 'slow' || providerState === 'unavailable') return;
    const timer = window.setTimeout(() => {
      if (!providerAllowsAutomaticFailover(activeServer)) {
        setProviderState('slow');
        return;
      }
      attemptedServers.current.add(serverId);
      const nextId = nextPlaybackServerId(servers, room.mediaType, serverId, attemptedServers.current);
      if (!nextId) {
        setProviderState('unavailable');
        return;
      }
      if (isHost) onHostServerChange?.(nextId);
      else setServerOverride(nextId === roomServerId ? '' : nextId);
      setLoaded(false);
      setProviderState('loading');
    }, PARTY_PLAYBACK_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [activeServer, isHost, onHostServerChange, providerState, room.mediaType, roomServerId, serverId, servers, shouldMountPlayer]);

  useEffect(() => {
    if (!guestUnlocked) return;
    const retries = [750, 1750, 3500, 6000].map((delay) => window.setTimeout(syncPlayer, delay));
    const timer = window.setTimeout(() => setGuestUnlocked(false), 15000);
    return () => {
      retries.forEach((retry) => window.clearTimeout(retry));
      window.clearTimeout(timer);
    };
  }, [guestUnlocked]);

  const activateGuest = () => {
    setGuestActivated(true);
    setGuestUnlocked(true);
    send('mute', { muted: false });
    send('volume', { level: 1 });
    syncPlayer();
    onSyncHealth?.({ status: commandMode === 'none' ? 'limited' : 'connecting', offsetSeconds: null, serverId });
  };

  const chooseServer = (nextServerId: string) => {
    if (isHost) onHostServerChange?.(nextServerId);
    else setServerOverride(nextServerId === roomServerId ? '' : nextServerId);
    setServerOpen(false);
    setLoaded(false);
    setProviderState('loading');
    setGuestActivated(false);
    setGuestUnlocked(false);
  };

  const retryProvider = () => {
    attemptedServers.current = new Set();
    setProviderState('loading');
    setLoaded(false);
  };

  const nextProvider = () => {
    if (servers.length < 2) {
      retryProvider();
      return;
    }
    const index = Math.max(0, servers.findIndex((server) => server.id === serverId));
    chooseServer(servers[(index + 1) % servers.length].id);
  };

  if (!playbackUrl) return <div className="party-player-missing"><strong>Friends playback is not connected</strong><span>Add the authorized party embed templates to the environment.</span></div>;

  return <div className={`party-video party-video--full ${isHost ? 'is-host' : 'is-guest'} ${room.isOfficial ? 'is-official' : ''} ${guestActivated ? 'is-guest-activated' : ''} ${guestUnlocked ? 'is-guest-unlocked' : ''}`}>
    {shouldMountPlayer
      ? <iframe ref={iframe} key={playbackUrl} title={`${room.titleName} full ${room.mediaType === 'movie' ? 'movie' : 'episode'}`} src={playbackUrl} allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setLoaded(true)} />
      : <div className="party-video__paused" role="status" style={imageUrl(room.backdropPath ?? null, 'w1280') ? { '--paused-backdrop': `url(${imageUrl(room.backdropPath ?? null, 'w1280')})` } as React.CSSProperties : undefined}><span><Pause fill="currentColor" /></span><strong>{isHost ? 'Room paused' : 'Paused by the host'}</strong><small>{isHost ? 'Resume when everyone is ready.' : 'Playback will resume for everyone together.'}</small></div>}
    {shouldMountPlayer && providerState !== 'ready' && <div className="party-video__provider-status" role="status">
      <span>{
        providerState === 'unavailable'
          ? 'Provider unavailable. Retry or switch servers.'
          : providerState === 'slow'
            ? 'This server is taking too long'
            : `Connecting to ${activeServer?.label ?? 'server'}...`
      }</span>
      {(providerState === 'slow' || providerState === 'unavailable') && <>
        <button type="button" onClick={retryProvider}>Retry</button>
        {servers.length > 1 && <button type="button" onClick={nextProvider}>Next server</button>}
      </>}
    </div>}
    {isHost && <div className="party-video__host-note"><strong>Host controls</strong><span>Use the player controls \u00b7 your changes sync to everyone</span></div>}
    {!isHost && shouldMountPlayer && <div className={`party-video__lock ${!room.isOfficial && !guestActivated ? 'party-video__lock--action' : ''}`}>{room.isOfficial
      ? <span>Tap the player once to join the public timeline</span>
      : guestActivated
        ? <span>{room.playbackState === 'paused' ? 'Paused by host' : guestUnlocked ? 'Joining the host\u2026' : 'Synced to host'}</span>
        : <button type="button" aria-label="Join playback" onClick={activateGuest}><strong>Join playback</strong><small>One tap unlocks video and sound in this browser</small></button>}
    </div>}
    <div className="party-server-picker">
      <button type="button" aria-label="Open room server list" aria-expanded={serverOpen} onClick={() => setServerOpen((open) => !open)}><Server /><span>{activeServer?.label ?? 'Server'}{serverOverride && <small>Personal fallback</small>}</span><ChevronDown /></button>
      {serverOpen && <div role="menu">{!isHost && serverOverride && <button type="button" onClick={() => chooseServer(roomServerId)} aria-label="Use room server"><span><strong>Use room server</strong><small>Follow the host's provider choice</small></span></button>}{servers.map((server) => <button type="button" role="menuitem" key={server.id} className={server.id === serverId ? 'active' : ''} onClick={() => chooseServer(server.id)}><span><strong>{server.label}</strong><small>{isHost ? 'Sets the provider for the room' : server.id === roomServerId ? 'Room choice' : server.description}</small></span>{server.id === serverId && <Check />}</button>)}</div>}
    </div>
  </div>;
}
