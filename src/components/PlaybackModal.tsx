import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, Film, LoaderCircle, RotateCw, ShieldCheck, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import { buildPlaybackUrl, canResumePlaybackServer, getDefaultPlaybackServerId, getPlaybackServers, type PlaybackConfig } from '../lib/playback';
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

export function PlaybackModal({ item, config, client, onClose, onSelect }: PlaybackModalProps) {
  const servers = useMemo(() => getPlaybackServers(config), [config]);
  const initialProgress = useMemo(() => readPlaybackProgress(item), [item.id, item.mediaType]);
  const initialSavedServer = servers.find((server) => server.id === initialProgress?.serverId);
  const canResumeInitialProgress = canResumePlaybackServer(initialSavedServer, item.mediaType);
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  const [serverId, setServerId] = useState(() => canResumeInitialProgress ? initialSavedServer!.id : getDefaultPlaybackServerId(servers, item.mediaType));
  const [resumeAt, setResumeAt] = useState(() => canResumeInitialProgress ? initialProgress?.position ?? 0 : 0);
  const [serverOpen, setServerOpen] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [playerState, setPlayerState] = useState<'loading' | 'loaded' | 'slow'>('loading');
  const [context, setContext] = useState<TitleContext | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const progressPosition = useRef(canResumeInitialProgress ? initialProgress?.position ?? 0 : 0);
  const progressDuration = useRef(canResumeInitialProgress ? initialProgress?.duration : undefined);
  const playbackUrl = buildPlaybackUrl(item, config, { season, episode, startAt: resumeAt }, serverId);
  const activeServer = servers.find((server) => server.id === serverId) ?? servers[0];
  const playerName = item.mediaType === 'movie' ? 'Movie player' : 'TV player';

  useEffect(() => {
    const saved = readPlaybackProgress(item, season, episode);
    const savedServer = servers.find((server) => server.id === saved?.serverId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    setServerId(canResumeSaved ? savedServer!.id : getDefaultPlaybackServerId(servers, item.mediaType));
    setResumeAt(canResumeSaved ? saved?.position ?? 0 : 0);
    progressPosition.current = canResumeSaved ? saved?.position ?? 0 : 0;
    progressDuration.current = canResumeSaved ? saved?.duration : undefined;
  }, [episode, item.id, item.mediaType, season, servers]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow) return;
      if (activeServer?.commandMode === 'cinesrc' && event.origin !== 'https://cinesrc.st') return;
      const progress = parsePlaybackProgressEvent(event.data);
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
    client.getTitleContext(item).then((result) => { if (!cancelled) setContext(result); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, item.id, item.mediaType]);

  useEffect(() => {
    setPlayerState('loading');
    const timer = window.setTimeout(() => setPlayerState((state) => state === 'loading' ? 'slow' : state), 9000);
    return () => window.clearTimeout(timer);
  }, [playbackUrl, playerRevision]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const retry = () => setPlayerRevision((revision) => revision + 1);
  const selectServer = (nextId: string) => {
    savePlaybackProgress(item, { position: progressPosition.current, duration: progressDuration.current, serverId: nextId }, season, episode);
    setResumeAt(progressPosition.current);
    setServerId(nextId);
    setServerOpen(false);
    setPlayerRevision((revision) => revision + 1);
  };
  const nextServer = () => {
    if (servers.length < 2) { retry(); return; }
    const index = Math.max(0, servers.findIndex((server) => server.id === serverId));
    selectServer(servers[(index + 1) % servers.length].id);
  };
  const selectEpisode = (nextSeason: number, nextEpisode: number) => {
    const saved = readPlaybackProgress(item, nextSeason, nextEpisode);
    const savedServer = servers.find((server) => server.id === saved?.serverId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    setSeason(nextSeason);
    setEpisode(nextEpisode);
    setServerId(canResumeSaved ? savedServer!.id : getDefaultPlaybackServerId(servers, item.mediaType));
    setResumeAt(canResumeSaved ? saved?.position ?? 0 : 0);
    progressPosition.current = canResumeSaved ? saved?.position ?? 0 : 0;
    progressDuration.current = canResumeSaved ? saved?.duration : undefined;
    setPlayerRevision((revision) => revision + 1);
  };
  const recommendations = context?.recommendations ?? [];

  return <motion.div className="overlay playback-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section className="playback-modal" role="dialog" aria-label={playerName} aria-modal="true" initial={{ y: 26, scale: .985 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .99 }}>
      <header className="playback-modal__header">
        <div className="playback-brand"><span>GlockTV player</span><small>{item.mediaType === 'movie' ? 'Feature' : `S${season} · E${episode}`} · {item.title}</small></div>
        <div className="playback-modal__actions">
          {servers.length > 0 && <div className="server-picker">
            <button type="button" className="server-picker__trigger" aria-label="Open server list" aria-expanded={serverOpen} onClick={() => setServerOpen((open) => !open)}><ShieldCheck /><span><small>Server</small>{activeServer?.label}</span><ChevronDown /></button>
            {serverOpen && <div className="server-picker__menu" role="menu">{servers.map((server) => <button type="button" role="menuitem" key={server.id} className={server.id === serverId ? 'active' : ''} onClick={() => selectServer(server.id)}><span><strong>{server.label}</strong><small>{server.description}</small></span>{server.id === serverId && <Check />}</button>)}</div>}
          </div>}
          <button type="button" className="playback-retry" aria-label="Retry player" onClick={retry}><RotateCw /><span>Retry</span></button>
          <button type="button" aria-label="Close player" onClick={onClose}><X /></button>
        </div>
      </header>
      {playbackUrl ? <div className="playback-frame">
        <iframe ref={iframe} key={`${playbackUrl}-${playerRevision}`} title={`${item.title} playback`} src={playbackUrl}
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
          referrerPolicy="strict-origin-when-cross-origin" onLoad={() => setPlayerState('loaded')} />
        {playerState !== 'loaded' && <div className={`playback-status playback-status--${playerState}`}><LoaderCircle className="spin" /><span>{playerState === 'slow' ? 'Still loading. Try another server.' : `Connecting to ${activeServer?.label ?? 'server'}…`}</span>{playerState === 'slow' && <button type="button" onClick={nextServer}>Next server</button>}</div>}
      </div> : <div className="playback-unconfigured"><Film /><strong>Playback source not connected</strong><p>Add your authorized {item.mediaType === 'movie' ? 'movie' : 'TV'} embed URL template to the GlockTV environment configuration.</p></div>}
      <footer className="playback-modal__footer">
        <div><span>{item.mediaType === 'movie' ? 'Feature presentation' : 'Episode playback'}</span><h2>{item.title}</h2><strong>{item.year} · {item.genres.slice(0, 2).join(' · ') || (item.mediaType === 'movie' ? 'Movie' : 'Series')}</strong></div>
        <small><ShieldCheck /> Pop-up windows are blocked. Ads drawn inside a third-party player cannot be removed by GlockTV.</small>
      </footer>
      {item.mediaType === 'tv' && <EpisodeBrowser client={client} seriesId={item.id} activeSeason={season} activeEpisode={episode} onSelect={selectEpisode} />}
      {!!recommendations.length && <section className="playback-recommendations" aria-label="More like this"><header><span>Keep watching</span><h3>More like this</h3></header><div>{recommendations.slice(0, 6).map((recommendation) => <button type="button" key={`${recommendation.mediaType}-${recommendation.id}`} onClick={() => onSelect?.(recommendation)}>{imageUrl(recommendation.backdropPath ?? recommendation.posterPath, 'w500') ? <img src={imageUrl(recommendation.backdropPath ?? recommendation.posterPath, 'w500')!} alt="" /> : <span className="playback-recommendations__fallback"><Film /></span>}<strong>{recommendation.title}</strong><small>{recommendation.year} · ★ {recommendation.rating.toFixed(1)}</small></button>)}</div></section>}
    </motion.section>
  </motion.div>;
}
