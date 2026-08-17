import type { MediaItem } from './media';

export const PLAYBACK_PROGRESS_KEY = 'glocktv:playback-progress:v1';

export interface PlaybackProgress {
  position: number;
  duration?: number;
  serverId?: string;
  updatedAt: string;
}

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
  item: Pick<MediaItem, 'id' | 'mediaType'>,
  progress: Omit<PlaybackProgress, 'updatedAt'>,
  season = 1,
  episode = 1,
) {
  if (!Number.isFinite(progress.position) || progress.position < 0) return;
  const store = readStore();
  store[playbackProgressId(item, season, episode)] = {
    position: Math.floor(progress.position),
    duration: Number.isFinite(progress.duration) && (progress.duration ?? 0) > 0 ? Math.floor(progress.duration!) : undefined,
    serverId: progress.serverId,
    updatedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify(store));
  } catch {
    // Playback continues even when private browsing or storage limits reject persistence.
  }
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
