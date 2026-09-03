import type { MediaItem } from './media';
import {
  isProgressComplete,
  parseProgressKey,
  sanitizeProgressEntry,
  type ProgressEntry,
} from './watchProgress';

export const PLAYBACK_PROGRESS_KEY = 'glocktv:playback-progress:v1';

export interface PlaybackProgress {
  position: number;
  duration?: number;
  serverId?: string;
  updatedAt: string;
  /*
   * Enough to draw a Continue Watching tile from this device alone, so a guest
   * with no account still gets a real surface rather than a list of ids. Older
   * stored rows predate these and simply lack them; a tile with no title falls
   * back rather than failing.
   */
  title?: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  completed?: boolean;
}

/* The snapshot half of a save. The player already holds the whole item, so
   nothing has to be looked up to record one. */
export type ProgressSubject =
  Pick<MediaItem, 'id' | 'mediaType'>
  & Partial<Pick<MediaItem, 'title' | 'posterPath' | 'backdropPath'>>;

type ProgressStore = Record<string, PlaybackProgress>;

export function playbackProgressId(item: Pick<MediaItem, 'id' | 'mediaType'>, season = 1, episode = 1) {
  return item.mediaType === 'movie' ? `movie:${item.id}` : `tv:${item.id}:s${season}:e${episode}`;
}

function readStore(): ProgressStore {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed as ProgressStore : {};
  } catch {
    return {};
  }
}

export function readPlaybackProgress(item: Pick<MediaItem, 'id' | 'mediaType'>, season = 1, episode = 1): PlaybackProgress | null {
  const saved = readStore()[playbackProgressId(item, season, episode)];
  if (!saved || !Number.isFinite(saved.position) || saved.position < 0) return null;
  return {
    position: Math.floor(saved.position),
    duration: Number.isFinite(saved.duration) && (saved.duration ?? 0) > 0 ? Math.floor(saved.duration!) : undefined,
    serverId: typeof saved.serverId === 'string' ? saved.serverId : undefined,
    updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : new Date(0).toISOString(),
  };
}

export function savePlaybackProgress(
  item: ProgressSubject,
  progress: Omit<PlaybackProgress, 'updatedAt'>,
  season = 1,
  episode = 1,
): PlaybackProgress | null {
  if (!Number.isFinite(progress.position) || progress.position < 0) return null;
  const duration = Number.isFinite(progress.duration) && (progress.duration ?? 0) > 0
    ? Math.floor(progress.duration!)
    : undefined;
  const position = Math.floor(progress.position);
  const saved: PlaybackProgress = {
    position,
    duration,
    serverId: progress.serverId,
    updatedAt: new Date().toISOString(),
    /* Kept if the caller has it, preserved from the previous write if not, so
       changing server mid-film does not drop the tile's artwork. */
    title: progress.title ?? item.title ?? readStore()[playbackProgressId(item, season, episode)]?.title,
    posterPath: progress.posterPath ?? item.posterPath ?? null,
    backdropPath: progress.backdropPath ?? item.backdropPath ?? null,
    completed: progress.completed ?? isProgressComplete(position, duration),
  };

  const store = readStore();
  store[playbackProgressId(item, season, episode)] = saved;
  writeStore(store);
  return saved;
}

function writeStore(store: ProgressStore) {
  try {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify(store));
  } catch {
    // Playback continues even when private browsing or storage limits reject persistence.
  }
}

/*
 * Everything this device has recorded, as domain entries.
 *
 * This is the guest's whole Continue Watching list, and the local half of a
 * signed-in viewer's. Unreadable rows are dropped rather than shown: the store
 * is hand-editable and has held at least two shapes over time.
 */
export function localProgressEntries(): ProgressEntry[] {
  const store = readStore();
  const entries: ProgressEntry[] = [];

  for (const [key, value] of Object.entries(store)) {
    const identity = parseProgressKey(key);
    if (!identity || !value || typeof value !== 'object') continue;
    const entry = sanitizeProgressEntry({
      ...identity,
      positionSeconds: value.position,
      durationSeconds: value.duration,
      completed: value.completed,
      providerId: value.serverId,
      title: value.title,
      posterPath: value.posterPath,
      backdropPath: value.backdropPath,
      updatedAt: value.updatedAt,
    });
    if (entry) entries.push(entry);
  }

  return entries;
}

/* Write a reconciled entry back down to this device, so the local store is not
   permanently behind what another device already knows. */
export function writeLocalProgressEntry(entry: ProgressEntry) {
  const store = readStore();
  store[playbackProgressId(
    { id: entry.mediaId, mediaType: entry.mediaType },
    entry.seasonNumber,
    entry.episodeNumber,
  )] = {
    position: entry.positionSeconds,
    duration: entry.durationSeconds,
    serverId: entry.providerId,
    updatedAt: entry.updatedAt,
    title: entry.title,
    posterPath: entry.posterPath,
    backdropPath: entry.backdropPath,
    completed: entry.completed,
  };
  writeStore(store);
}

/* Forgetting a title is the viewer's own decision, so it is a real delete
   rather than a hidden flag. */
export function removeLocalProgress(
  item: Pick<MediaItem, 'id' | 'mediaType'>,
  /* No defaults: an episode removed under the wrong season silently deletes
     nothing, and the caller always knows which episode it is showing. */
  season: number,
  episode: number,
) {
  const store = readStore();
  delete store[playbackProgressId(item, season, episode)];
  writeStore(store);
}

export function parsePlaybackProgressEvent(raw: unknown) {
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object') return null;
    const message = payload as {
      type?: unknown;
      event?: unknown;
      currentTime?: unknown;
      duration?: unknown;
      data?: { event?: unknown; currentTime?: unknown; time?: unknown; duration?: unknown };
    };
    if (typeof message.type === 'string' && message.type.startsWith('cinesrc:')) {
      const event = message.type.slice('cinesrc:'.length);
      if (!['timeupdate', 'seeked', 'pause', 'ended'].includes(event)) return null;
      const currentTime = Number(message.currentTime);
      const duration = Number(message.duration);
      return {
        event,
        currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : null,
        duration: Number.isFinite(duration) ? Math.max(0, duration) : undefined,
      };
    }
    const isMPlayer = message.type === 'mplayer';
    const event = isMPlayer ? message.event : message.data?.event;
    if ((message.type !== 'PLAYER_EVENT' && !isMPlayer) || !['timeupdate', 'seeked', 'pause', 'ended'].includes(String(event))) return null;
    const currentTime = Number(isMPlayer ? message.currentTime : message.data?.currentTime ?? message.data?.time);
    const duration = Number(message.data?.duration);
    return {
      event: String(event),
      currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime) : null,
      duration: Number.isFinite(duration) ? Math.max(0, duration) : undefined,
    };
  } catch {
    return null;
  }
}
