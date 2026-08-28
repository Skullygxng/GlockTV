import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, Film, LoaderCircle, RotateCw, ShieldCheck, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import { buildPlaybackUrl, canResumePlaybackServer, getDefaultPlaybackServerId, getPlaybackServers, type PlaybackConfig } from '../lib/playback';
import {
  PLAYBACK_FALLBACK_MS,
  PLAYBACK_SLOW_MS,
  isProviderPlaybackSignal,
  nextPlaybackServerId,
  providerAllowsAutomaticFailover,
} from '../lib/playbackRecovery';
import { parsePlaybackProgressEvent, readPlaybackProgress, savePlaybackProgress } from '../lib/playbackProgress';
import type { TitleContext, TmdbClient } from '../lib/tmdb';
import { EpisodeBrowser } from './EpisodeBrowser';
import '../playback.css';

interface PlaybackModalProps {
  item: MediaItem;
  config: PlaybackConfig;
  client: TmdbClient;
  onClose: () => void;
  onSelect?: (item: MediaItem) => void;
}

type PlayerState = 'loading' | 'loaded' | 'slow' | 'unavailable';

export function PlaybackModal({ item, config, client, onClose, onSelect }: PlaybackModalProps) {
  const servers = useMemo(() => getPlaybackServers(config), [config]);
  const compatibleServers = useMemo(() => servers.filter((server) => (
    item.mediaType === 'movie'
      ? Boolean(server.movieUrlTemplate?.trim())
      : Boolean(server.tvUrlTemplate?.trim())
  )), [item.mediaType, servers]);
  const initialProgress = useMemo(() => readPlaybackProgress(item), [item.id, item.mediaType]);
  const initialSavedServer = compatibleServers.find((server) => server.id === initialProgress?.serverId);
  const canResumeInitialProgress = canResumePlaybackServer(initialSavedServer, item.mediaType);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [serverId, setServerId] = useState(() => canResumeInitialProgress
    ? initialSavedServer!.id
    : getDefaultPlaybackServerId(compatibleServers, item.mediaType));
  const [resumeAt, setResumeAt] = useState(() => canResumeInitialProgress ? initialProgress?.position ?? 0 : 0);
  const [serverOpen, setServerOpen] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [context, setContext] = useState<TitleContext | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const playerReady = useRef(false);
  const attemptedServers = useRef(new Set<string>());
  const progressPosition = useRef(canResumeInitialProgress ? initialProgress?.position ?? 0 : 0);
  const progressDuration = useRef(canResumeInitialProgress ? initialProgress?.duration : undefined);
  const playbackUrl = buildPlaybackUrl(item, config, { season, episode, startAt: resumeAt }, serverId);
  const activeServer = compatibleServers.find((server) => server.id === serverId) ?? compatibleServers[0];
  const playerName = item.mediaType === 'movie' ? 'Movie player' : 'TV player';

  const retry = () => {
    attemptedServers.current = new Set();
    playerReady.current = false;
    setPlayerState('loading');
    setServerId(getDefaultPlaybackServerId(compatibleServers, item.mediaType));
    setPlayerRevision((revision) => revision + 1);
  };

  const selectServer = (nextId: string) => {
    const nextServer = compatibleServers.find((server) => server.id === nextId);
    if (!nextServer) return;

    const canResumeNext = canResumePlaybackServer(nextServer, item.mediaType);
    savePlaybackProgress(item, {
      position: progressPosition.current,
      duration: progressDuration.current,
      serverId: nextId,
    }, season, episode);

    setResumeAt(canResumeNext ? progressPosition.current : 0);
    setServerId(nextId);
    setServerOpen(false);
    setPlayerRevision((revision) => revision + 1);
  };

  const nextServer = () => {
    if (compatibleServers.length < 2) {
      retry();
      return;
    }
    const index = Math.max(0, compatibleServers.findIndex((server) => server.id === serverId));
    selectServer(compatibleServers[(index + 1) % compatibleServers.length].id);
  };

  const selectEpisode = (nextSeason: number, nextEpisode: number) => {
    const saved = readPlaybackProgress(item, nextSeason, nextEpisode);
    const savedServer = compatibleServers.find((server) => server.id === saved?.serverId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    setSeason(nextSeason);
    setEpisode(nextEpisode);
    setServerId(canResumeSaved ? savedServer!.id : getDefaultPlaybackServerId(compatibleServers, item.mediaType));
    setResumeAt(canResumeSaved ? saved?.position ?? 0 : 0);
    progressPosition.current = canResumeSaved ? saved?.position ?? 0 : 0;
    progressDuration.current = canResumeSaved ? saved?.duration : undefined;
    setPlayerRevision((revision) => revision + 1);
  };

  useEffect(() => {
    const saved = readPlaybackProgress(item, season, episode);
    const savedServer = compatibleServers.find((server) => server.id === saved?.serverId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    setServerId(canResumeSaved ? savedServer!.id : getDefaultPlaybackServerId(compatibleServers, item.mediaType));
    setResumeAt(canResumeSaved ? saved?.position ?? 0 : 0);
    progressPosition.current = canResumeSaved ? saved?.position ?? 0 : 0;
    progressDuration.current = canResumeSaved ? saved?.duration : undefined;
    attemptedServers.current = new Set();
    playerReady.current = false;
  }, [compatibleServers, episode, item.id, item.mediaType, season]);

  useEffect(() => {
    if (!compatibleServers.length) return;
    if (compatibleServers.some((server) => server.id === serverId)) return;
    setServerId(getDefaultPlaybackServerId(compatibleServers, item.mediaType));
    setResumeAt(0);
  }, [compatibleServers, item.mediaType, serverId]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      if (activeServer?.commandMode === 'cinesrc' && event.origin !== 'https://cinesrc.st') return;
      const progress = parsePlaybackProgressEvent(event.data);
      if (isProviderPlaybackSignal(event.data)) {
        playerReady.current = true;
        setPlayerState('loaded');
      }
      if (!progress) return;
      if (progress.currentTime !== null) progressPosition.current = progress.currentTime;
      if (progress.duration) progressDuration.current = progress.duration;
      if (progress.event === 'ended' && progressDuration.current) progressPosition.current = 0;
      savePlaybackProgress(item, {
        position: progressPosition.current,
        duration: progressDuration.current,
        serverId,
      }, season, episode);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeServer?.commandMode, episode, item.id, item.mediaType, season, serverId]);

  useEffect(() => {
    let cancelled = false;
    setContext(null);
    client.getTitleContext(item)
      .then((result) => { if (!cancelled) setContext(result); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, item.id, item.mediaType]);

  useEffect(() => {
    if (!playbackUrl) return;

    playerReady.current = false;
    setPlayerState('loading');

    const slowTimer = window.setTimeout(() => {
      if (!playerReady.current) setPlayerState((current) => current === 'unavailable' ? current : 'slow');
    }, PLAYBACK_SLOW_MS);

    const fallbackTimer = window.setTimeout(() => {
      if (playerReady.current) return;
      if (!providerAllowsAutomaticFailover(activeServer)) {
        setPlayerState((current) => current === 'unavailable' ? current : 'slow');
        return;
      }
      attemptedServers.current.add(serverId);
      const nextId = nextPlaybackServerId(compatibleServers, item.mediaType, serverId, attemptedServers.current);
      if (!nextId) {
        setPlayerState('unavailable');
        return;
      }
      const nextServerConfig = compatibleServers.find((server) => server.id === nextId);
      if (!nextServerConfig) {
        setPlayerState('unavailable');
        return;
      }
      const canResumeNext = canResumePlaybackServer(nextServerConfig, item.mediaType);
      setResumeAt(canResumeNext ? progressPosition.current : 0);
      setServerId(nextId);
      setPlayerRevision((revision) => revision + 1);
    }, PLAYBACK_FALLBACK_MS);

    return () => {
      window.clearTimeout(slowTimer);
      window.clearTimeout(fallbackTimer);
    };
  }, [activeServer, compatibleServers, item.mediaType, playbackUrl, playerRevision, serverId]);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.classList.add('playback-open');
    body.classList.add('playback-open');
    closeButton.current?.focus();

    return () => {
      root.classList.remove('playback-open');
      body.classList.remove('playback-open');
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (serverOpen) {
        setServerOpen(false);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, serverOpen]);

  const recommendations = context?.recommendations ?? [];

  return <motion.div className="overlay playback-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section className="playback-modal" role="dialog" aria-label={playerName} aria-modal="true" initial={{ y: 26, scale: .985 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .99 }}>
      <header className="playback-modal__header">
        <div className="playback-brand"><span>GlockTV player</span><small>{item.mediaType === 'movie' ? 'Feature' : `S${season} / E${episode}`} - {item.title}</small></div>
        <div className="playback-modal__actions">
          {compatibleServers.length > 0 && <div className="server-picker">
            <button type="button" className="server-picker__trigger" aria-label="Open server list" aria-expanded={serverOpen} onClick={() => setServerOpen((open) => !open)}><ShieldCheck /><span><small>Server</small>{activeServer?.label}</span><ChevronDown /></button>
            {serverOpen && <div className="server-picker__menu" role="menu">{compatibleServers.map((server) => <button type="button" role="menuitem" key={server.id} className={server.id === serverId ? 'active' : ''} onClick={() => selectServer(server.id)}><span><strong>{server.label}</strong><small>{server.description}</small></span>{server.id === serverId && <Check />}</button>)}</div>}
          </div>}
          <button type="button" className="playback-retry" aria-label="Retry player" onClick={retry}><RotateCw /><span>Retry</span></button>
          <button ref={closeButton} type="button" aria-label="Close player" onClick={onClose}><X /></button>
        </div>
      </header>
      {playbackUrl ? <div className="playback-frame" aria-busy={playerState !== 'loaded'}>
        <iframe
          ref={iframe}
          key={`${playbackUrl}-${playerRevision}`}
          title={`${item.title} playback`}
          src={playbackUrl}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin"
          onLoad={() => undefined}
          onError={() => setPlayerState((current) => current === 'loaded' ? current : 'slow')}
        />
        {playerState !== 'loaded' && <div className={`playback-status playback-status--${playerState}`} role="status">
          {playerState !== 'unavailable' && <LoaderCircle className="spin" />}
          <span>{
            playerState === 'unavailable'
              ? 'Provider unavailable. Try another server or retry.'
              : playerState === 'slow'
                ? 'This server is taking too long.'
                : `Connecting to ${activeServer?.label ?? 'server'}...`
          }</span>
          {(playerState === 'slow' || playerState === 'unavailable') && <div className="playback-status__actions">
            <button type="button" onClick={retry}>Retry</button>
            {compatibleServers.length > 1 && <button type="button" onClick={nextServer}>Next server</button>}
          </div>}
        </div>}
      </div> : <div className="playback-unconfigured"><Film /><strong>Playback source not connected</strong><p>Add your authorized {item.mediaType === 'movie' ? 'movie' : 'TV'} embed URL template to the GlockTV environment configuration.</p></div>}
      <footer className="playback-modal__footer">
        <div><span>{item.mediaType === 'movie' ? 'Feature presentation' : 'Episode playback'}</span><h2>{item.title}</h2><strong>{item.year} - {item.genres.slice(0, 2).join(' - ') || (item.mediaType === 'movie' ? 'Movie' : 'Series')}</strong></div>
        <small><ShieldCheck /> Pop-up windows are blocked. Ads drawn inside a third-party player cannot be removed by GlockTV.</small>
      </footer>
      {item.mediaType === 'tv' && <EpisodeBrowser client={client} seriesId={item.id} activeSeason={season} activeEpisode={episode} onSelect={selectEpisode} />}
      {!!recommendations.length && <section className="playback-recommendations" aria-label="More like this"><header><span>Keep watching</span><h3>More like this</h3></header><div>{recommendations.slice(0, 6).map((recommendation) => <button type="button" key={`${recommendation.mediaType}-${recommendation.id}`} onClick={() => onSelect?.(recommendation)}>{imageUrl(recommendation.backdropPath ?? recommendation.posterPath, 'w500') ? <img loading="lazy" decoding="async" src={imageUrl(recommendation.backdropPath ?? recommendation.posterPath, 'w500')!} alt="" /> : <span className="playback-recommendations__fallback"><Film /></span>}<strong>{recommendation.title}</strong><small>{recommendation.year} - Rating {recommendation.rating.toFixed(1)}</small></button>)}</div></section>}
    </motion.section>
  </motion.div>;
}
