import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown, Film, LoaderCircle, RotateCw, ShieldCheck, X } from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import { buildPlaybackUrl, canResumePlaybackServer, getDefaultPlaybackServerId, getPlaybackServers, type PlaybackConfig } from '../lib/playback';
import { useDialogBehavior } from '../hooks/useDialogBehavior';
import {
  PLAYBACK_FALLBACK_MS,
  PLAYBACK_SLOW_MS,
  isProviderPlaybackSignal,
  nextPlaybackServerId,
  providerAllowsAutomaticFailover,
} from '../lib/playbackRecovery';
import { parsePlaybackProgressEvent } from '../lib/playbackProgress';
import { useWatchProgress } from './WatchProgressProvider';
import { formatProgressPosition, isProgressComplete, isResumable } from '../lib/watchProgress';
import type { TitleContext, TmdbClient } from '../lib/tmdb';
import { EpisodeBrowser } from './EpisodeBrowser';
import '../playback.css';

interface PlaybackModalProps {
  item: MediaItem;
  config: PlaybackConfig;
  client: TmdbClient;
  /* Where to open a series. Omitted everywhere except a resume, which knows
     the real episode the viewer stopped on. */
  initialSeason?: number;
  initialEpisode?: number;
  onClose: () => void;
  onSelect?: (item: MediaItem) => void;
}

type PlayerState = 'loading' | 'loaded' | 'slow' | 'unavailable';

/*
 * How long the resumed-from notice stays up.
 *
 * It has to go away on its own. The player's controls belong to the provider
 * and sit inside the iframe, so anything GlockTV draws over the frame is
 * potentially covering a control it cannot see - which is exactly the thing
 * this codebase refuses to do with an ad, and the same rule applies to its own
 * chrome.
 */
export const RESUME_NOTICE_MS = 8_000;

/* A season or episode of 0 is the movie sentinel, not a real episode. */
function positiveOr(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function PlaybackModal({
  item,
  config,
  client,
  initialSeason,
  initialEpisode,
  onClose,
  onSelect,
}: PlaybackModalProps) {
  const servers = useMemo(() => getPlaybackServers(config), [config]);
  const compatibleServers = useMemo(() => servers.filter((server) => (
    item.mediaType === 'movie'
      ? Boolean(server.movieUrlTemplate?.trim())
      : Boolean(server.tvUrlTemplate?.trim())
  )), [item.mediaType, servers]);
  const progress = useWatchProgress();

  /*
   * The resume point, taken once when the player opens.
   *
   * Deliberately not reactive: cloud history can finish loading a moment after
   * the player mounts, and seeking somebody who has already started watching is
   * worse than resuming from the slightly older position this device already
   * knew. A finished title returns nothing, so watching it again starts at the
   * beginning rather than at the credits.
   */
  const savedFor = useCallback((seasonNumber: number, episodeNumber: number) => {
    const entry = progress.entryFor(item, seasonNumber, episodeNumber);
    return isResumable(entry) ? entry : null;
  }, [progress, item.id, item.mediaType]);

  const initialProgress = useMemo(
    () => savedFor(positiveOr(initialSeason, 1), positiveOr(initialEpisode, 1)),
    /* Once per title. savedFor changes identity whenever any entry does. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item.id, item.mediaType],
  );
  const initialSavedServer = compatibleServers.find((server) => server.id === initialProgress?.providerId);
  const canResumeInitialProgress = canResumePlaybackServer(initialSavedServer, item.mediaType);
  const [season, setSeason] = useState(() => positiveOr(initialSeason, 1));
  const [episode, setEpisode] = useState(() => positiveOr(initialEpisode, 1));
  const [serverId, setServerId] = useState(() => canResumeInitialProgress
    ? initialSavedServer!.id
    : getDefaultPlaybackServerId(compatibleServers, item.mediaType));
  const [resumeAt, setResumeAt] = useState(() => canResumeInitialProgress ? initialProgress?.positionSeconds ?? 0 : 0);
  /*
   * What we resumed from, so the viewer is told rather than silently moved.
   * Cleared the moment they start over, change episode or change server.
   */
  const [resumedFrom, setResumedFrom] = useState(() => (
    canResumeInitialProgress ? initialProgress?.positionSeconds ?? 0 : 0
  ));
  const [nextEpisode, setNextEpisode] = useState<{ season: number; episode: number } | null>(null);
  /* Bumped when the provider says this episode finished, so the next-episode
     lookup runs again rather than once per episode. */
  const [finishedRevision, setFinishedRevision] = useState(0);
  const [serverOpen, setServerOpen] = useState(false);
  const [playerRevision, setPlayerRevision] = useState(0);
  const [playerState, setPlayerState] = useState<PlayerState>('loading');
  const [context, setContext] = useState<TitleContext | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const playerReady = useRef(false);
  const attemptedServers = useRef(new Set<string>());
  /* The server a position was observed on, read by record() without making it
     depend on the state value and re-subscribe the message listener. */
  const serverIdRef = useRef(serverId);
  const progressPosition = useRef(canResumeInitialProgress ? initialProgress?.positionSeconds ?? 0 : 0);
  const progressDuration = useRef(canResumeInitialProgress ? initialProgress?.durationSeconds : undefined);
  const playbackUrl = buildPlaybackUrl(item, config, { season, episode, startAt: resumeAt }, serverId);
  const activeServer = compatibleServers.find((server) => server.id === serverId) ?? compatibleServers[0];
  const playerName = item.mediaType === 'movie' ? 'Movie player' : 'TV player';

  /*
   * Every observed position leaves through here, so the local store and the
   * cloud can never be told two different things. flush is for the moments the
   * position matters most - pausing, finishing, changing episode, closing -
   * where waiting out the throttle could lose it.
   */
  const record = useCallback((flush = false) => {
    if (!Number.isFinite(progressPosition.current)) return;
    progress.recordProgress({
      subject: item,
      positionSeconds: progressPosition.current,
      durationSeconds: progressDuration.current,
      providerId: serverIdRef.current,
      seasonNumber: season,
      episodeNumber: episode,
      flush,
    });
  }, [progress, item, season, episode]);

  /*
   * The message listener reads this rather than closing over record directly.
   * record's identity changes with every position it reports, and a listener
   * that depends on it would tear down and re-add itself several times a
   * second for the whole of a film.
   */
  const recordRef = useRef(record);
  useEffect(() => { recordRef.current = record; }, [record]);

  /*
   * Start over is a real restart, not a seek: the position is zeroed and
   * recorded before the frame reloads, so leaving now does not put the old
   * resume point back the next time this title is opened.
   */
  const startOver = () => {
    progressPosition.current = 0;
    record(true);
    setResumeAt(0);
    setResumedFrom(0);
    setNextEpisode(null);
    setPlayerRevision((revision) => revision + 1);
  };

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
    serverIdRef.current = nextId;
    record(true);

    setResumeAt(canResumeNext ? progressPosition.current : 0);
    setResumedFrom(canResumeNext ? progressPosition.current : 0);
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
    /* The episode being left is the one whose position is about to be
       overwritten in the refs, so it is sent before they move. */
    record(true);

    const saved = savedFor(nextSeason, nextEpisode);
    const savedServer = compatibleServers.find((server) => server.id === saved?.providerId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    const resumePoint = canResumeSaved ? saved?.positionSeconds ?? 0 : 0;
    setSeason(nextSeason);
    setEpisode(nextEpisode);
    setNextEpisode(null);
    const nextServerId = canResumeSaved
      ? savedServer!.id
      : getDefaultPlaybackServerId(compatibleServers, item.mediaType);
    serverIdRef.current = nextServerId;
    setServerId(nextServerId);
    setResumeAt(resumePoint);
    setResumedFrom(resumePoint);
    progressPosition.current = resumePoint;
    progressDuration.current = canResumeSaved ? saved?.durationSeconds : undefined;
    setPlayerRevision((revision) => revision + 1);
  };

  useEffect(() => {
    const saved = savedFor(season, episode);
    const savedServer = compatibleServers.find((server) => server.id === saved?.providerId);
    const canResumeSaved = canResumePlaybackServer(savedServer, item.mediaType);
    const resumePoint = canResumeSaved ? saved?.positionSeconds ?? 0 : 0;
    const nextServerId = canResumeSaved
      ? savedServer!.id
      : getDefaultPlaybackServerId(compatibleServers, item.mediaType);
    serverIdRef.current = nextServerId;
    setServerId(nextServerId);
    setResumeAt(resumePoint);
    setResumedFrom(resumePoint);
    progressPosition.current = resumePoint;
    progressDuration.current = canResumeSaved ? saved?.durationSeconds : undefined;
    attemptedServers.current = new Set();
    playerReady.current = false;
    // savedFor is intentionally excluded: it changes identity on every recorded
    // position, and re-running this mid-playback would reset the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatibleServers, episode, item.id, item.mediaType, season]);

  useEffect(() => { serverIdRef.current = serverId; }, [serverId]);

  /* Say it, then get out of the way. Clearing the notice does not touch
     resumeAt, so the playback offset itself is unaffected. */
  useEffect(() => {
    if (resumedFrom <= 0) return;
    const timer = window.setTimeout(() => setResumedFrom(0), RESUME_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [resumedFrom, playerRevision]);

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
      if (isProviderPlaybackSignal(event.data)) {
        playerReady.current = true;
        setPlayerState('loaded');
      }
      const observed = parsePlaybackProgressEvent(event.data);
      if (!observed) return;
      if (observed.currentTime !== null) progressPosition.current = observed.currentTime;
      if (observed.duration) progressDuration.current = observed.duration;

      /*
       * An explicit ended is the provider telling us the title is over, which
       * counts as finished whatever the numbers say - some players stop
       * reporting a few seconds short of their own duration.
       */
      const finished = observed.event === 'ended'
        || isProgressComplete(progressPosition.current, progressDuration.current);
      if (observed.event === 'ended' && progressDuration.current) {
        progressPosition.current = progressDuration.current;
      }

      /* Pausing and finishing are the two positions worth not losing. */
      recordRef.current(observed.event === 'pause' || finished);
      if (finished) setFinishedRevision((value) => value + 1);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activeServer?.commandMode]);

  /*
   * Offer the next episode, but only one that actually exists.
   *
   * The season guide is the same real TMDB data the episode browser lists, so
   * an offer is never made for an episode number this series does not have -
   * no arithmetic on an assumed episode count, and nothing offered at all for
   * a client that cannot answer. It is an offer rather than an auto-advance:
   * these are third-party iframes, and quietly loading the next episode over
   * somebody who has stopped watching is worse than a button.
   */
  useEffect(() => {
    if (item.mediaType !== 'tv' || !finishedRevision || !client.getTvSeason) {
      return;
    }
    let cancelled = false;
    const wantedSeason = season;
    const wantedEpisode = episode + 1;

    client.getTvSeason(item.id, wantedSeason)
      .then((episodes) => {
        if (cancelled) return;
        const exists = episodes.some((candidate) => candidate.episodeNumber === wantedEpisode);
        if (exists) setNextEpisode({ season: wantedSeason, episode: wantedEpisode });
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [client, episode, finishedRevision, item.id, item.mediaType, season]);

  /* Whatever is still queued when the player closes is the last thing observed,
     so it is the position most worth keeping. */
  useEffect(() => () => { void progress.flushProgress(); }, [progress.flushProgress]);

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
    root.classList.add('playback-open');
    body.classList.add('playback-open');
    return () => {
      root.classList.remove('playback-open');
      body.classList.remove('playback-open');
    };
  }, []);

  /*
   * Escape peels the server menu first and the player second, as it always
   * has. Focus entry, focus restoration and Tab containment now come from the
   * shared dialog contract rather than a private copy of it.
   */
  const dialog = useDialogBehavior<HTMLElement>({
    onClose: () => {
      if (serverOpen) {
        setServerOpen(false);
        return;
      }
      onClose();
    },
    initialFocus: closeButton,
  });

  const recommendations = context?.recommendations ?? [];

  return <motion.div className="overlay playback-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.section ref={dialog} className="playback-modal" role="dialog" aria-label={playerName} aria-modal="true" initial={{ y: 26, scale: .985 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .99 }}>
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
        {/*
          * Resuming is the right default - it is what somebody who left partway
          * through almost always wants - but it should not happen silently. This
          * says where they were put and offers the other answer, so the choice is
          * theirs without costing a click in the common case.
          */}
        {resumedFrom > 0 && playerState !== 'unavailable' && <div className="playback-resumed" role="status">
          <span>Resumed from {formatProgressPosition(resumedFrom)}</span>
          <button type="button" onClick={startOver}>Start from the beginning</button>
        </div>}
        {nextEpisode && <div className="playback-next-episode" role="status">
          <span>Finished S{season} / E{episode}</span>
          <button type="button" onClick={() => selectEpisode(nextEpisode.season, nextEpisode.episode)}>
            Play S{nextEpisode.season} / E{nextEpisode.episode}
          </button>
          <button type="button" className="playback-next-episode__dismiss" aria-label="Dismiss next episode" onClick={() => setNextEpisode(null)}><X /></button>
        </div>}
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
