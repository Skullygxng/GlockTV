import { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Heart,
  Info,
  Play,
  Plus,
  ThumbsDown,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { imageUrl, type MediaItem } from '../lib/media';
import {
  createYouTubePlayer,
  type PartyPlayer,
  type PartyPlayerFactory,
} from './YouTubePartyPlayer';

const previewSoundKey = 'glocktv-preview-sound';
const previewDwellMs = 800;

function loadPreviewSoundPreference() {
  try {
    return sessionStorage.getItem(previewSoundKey) === 'on';
  } catch {
    return false;
  }
}

function savePreviewSoundPreference(enabled: boolean) {
  try {
    sessionStorage.setItem(
      previewSoundKey,
      enabled ? 'on' : 'off',
    );
  } catch {
    // Playback remains functional when storage is unavailable.
  }
}

export interface MediaCardProps {
  item: MediaItem;
  match: number;
  saved: boolean;
  trailerKey?: string | null;
  onToggleList: (item: MediaItem) => void;
  onWatch: (item: MediaItem) => void;
  onDetails: (item: MediaItem) => void;
  onTrailer: (item: MediaItem) => void;
  onLike: (item: MediaItem) => void;
  onSkip: (item: MediaItem) => void;
  trailerPlayerFactory?: PartyPlayerFactory;
}

function formatRuntime(minutes: number | null): string {
  if (!minutes) return 'Runtime TBD';

  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;

  return hours
    ? `${hours}h ${remaining}m`
    : `${remaining}m`;
}

export function MediaCard({
  item,
  match,
  saved,
  trailerKey = null,
  onToggleList,
  onWatch,
  onDetails,
  onTrailer,
  onLike,
  onSkip,
  trailerPlayerFactory = createYouTubePlayer,
}: MediaCardProps) {
  const artwork = imageUrl(
    item.posterPath ?? item.backdropPath,
    'w780',
  );

  const previewMount = useRef<HTMLDivElement>(null);
  const previewPlayer = useRef<PartyPlayer | null>(null);

  const [previewReady, setPreviewReady] = useState(false);
  const [previewMuted, setPreviewMuted] = useState(
    () => !loadPreviewSoundPreference(),
  );

  useEffect(() => {
    previewPlayer.current?.destroy();
    previewPlayer.current = null;

    setPreviewReady(false);
    setPreviewMuted(!loadPreviewSoundPreference());

    if (!trailerKey) return;

    let disposed = false;
    let player: PartyPlayer | null = null;

    const timer = window.setTimeout(() => {
      const mount = previewMount.current;

      if (disposed || !mount) return;

      const soundEnabled = loadPreviewSoundPreference();

      player = trailerPlayerFactory(
        mount,
        trailerKey,
        (readyPlayer) => {
          if (disposed) {
            readyPlayer.destroy();
            return;
          }

          previewPlayer.current = readyPlayer;

          if (soundEnabled) {
            readyPlayer.unmute();
          } else {
            readyPlayer.mute();
          }

          readyPlayer.play();

          setPreviewMuted(!soundEnabled);
          setPreviewReady(true);
        },
        () => undefined,
        {
          autoplay: true,
          controls: false,
          loop: true,
          disableKeyboard: true,
        },
      );

      previewPlayer.current = player;
    }, previewDwellMs);

    return () => {
      disposed = true;
      window.clearTimeout(timer);

      player?.destroy();

      if (previewPlayer.current === player) {
        previewPlayer.current = null;
      }
    };
  }, [trailerKey, trailerPlayerFactory]);

  const togglePreviewSound = () => {
    const player = previewPlayer.current;

    if (!player || !previewReady) return;

    if (previewMuted) {
      player.unmute();
      player.play();
    } else {
      player.mute();
    }

    const soundEnabled = previewMuted;

    savePreviewSoundPreference(soundEnabled);
    setPreviewMuted(!soundEnabled);
  };

  return (
    <article
      className="media-card"
      aria-label={`${item.title} recommendation`}
    >
      <div className="media-card__image-wrap">
        {artwork ? (
          <img
            className="media-card__image"
            src={artwork}
            alt=""
            fetchPriority="high"
          />
        ) : (
          <div className="media-card__fallback" />
        )}

        {trailerKey ? (
          <div
            className="media-card__video"
            aria-hidden="true"
          >
            <div
              ref={previewMount}
              title={`${item.title} autoplay trailer`}
            />
          </div>
        ) : null}

        <div className="media-card__shade" />

        <button
          className="media-card__mute"
          type="button"
          aria-label={
            !trailerKey
              ? 'Trailer preview unavailable'
              : !previewReady
                ? 'Trailer sound loading'
                : previewMuted
                  ? `Play ${item.title} trailer with sound`
                  : `Mute ${item.title} trailer`
          }
          disabled={!trailerKey || !previewReady}
          onClick={togglePreviewSound}
        >
          {previewMuted
            ? <VolumeX size={17} />
            : <Volume2 size={17} />}
        </button>

        <div
          className="media-card__actions"
          aria-label="Title actions"
        >
          <button
            type="button"
            aria-label={`Like ${item.title}`}
            onClick={() => onLike(item)}
          >
            <Heart />
          </button>

          <span>
            {item.voteCount > 999
              ? `${Math.round(item.voteCount / 1000)}K`
              : item.voteCount}
          </span>

          <button
            type="button"
            aria-label={`${saved ? 'Remove' : 'Add'} ${item.title} ${saved ? 'from' : 'to'} My List`}
            onClick={() => onToggleList(item)}
          >
            {saved
              ? <Bookmark fill="currentColor" />
              : <Plus />}
          </button>

          <span>My List</span>

          <button
            type="button"
            aria-label={`Details for ${item.title}`}
            onClick={() => onDetails(item)}
          >
            <Info />
          </button>

          <span>Details</span>

          <button
            type="button"
            aria-label={`Not interested in ${item.title}`}
            onClick={() => onSkip(item)}
          >
            <ThumbsDown />
          </button>

          <span>Skip</span>
        </div>
      </div>

      <div className="media-card__content">
        <p className="media-card__match">
          {match}% GlockTV match
        </p>

        <h1>{item.title}</h1>

        <p className="media-card__meta">
          <span>{item.year}</span>
          <i />
          <span>
            {item.genres.slice(0, 2).join(' · ')
              || (
                item.mediaType === 'movie'
                  ? 'Movie'
                  : 'TV'
              )}
          </span>
          <i />
          <span>{formatRuntime(item.runtime)}</span>
        </p>

        <p className="media-card__rating">
          <strong>★ {item.rating.toFixed(1)}</strong>
          <span>/10</span>
        </p>

        <p className="media-card__overview">
          {item.overview
            || 'Discover why this title belongs in your next watch.'}
        </p>

        <button
          className="media-card__watch"
          type="button"
          onClick={() => onWatch(item)}
        >
          <Play
            size={18}
            fill="currentColor"
          />

          {item.mediaType === 'movie'
            ? 'Watch movie'
            : 'Watch episode'}
        </button>

        <button
          className="media-card__trailer"
          type="button"
          onClick={() => onTrailer(item)}
        >
          <VolumeX size={16} />
          Play trailer
        </button>
      </div>
    </article>
  );
}