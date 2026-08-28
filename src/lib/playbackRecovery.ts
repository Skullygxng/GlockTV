import type { MediaItem } from './media';
import type { PlaybackServer } from './playback';

export const PLAYBACK_SLOW_MS = 8_000;
export const PLAYBACK_FALLBACK_MS = 14_000;
export const PARTY_PLAYBACK_FALLBACK_MS = 22_000;

export type PlaybackHealthState = 'loading' | 'slow' | 'ready' | 'unavailable';

export function serversForMedia(servers: PlaybackServer[], mediaType: MediaItem['mediaType']) {
  const key = mediaType === 'movie' ? 'movieUrlTemplate' : 'tvUrlTemplate';
  return servers.filter((server) => Boolean(server[key]?.trim()));
}

export function nextPlaybackServerId(
  servers: PlaybackServer[],
  mediaType: MediaItem['mediaType'],
  currentId: string,
  attemptedIds: Iterable<string>,
) {
  const compatible = serversForMedia(servers, mediaType);
  const attempted = new Set(attemptedIds);
  attempted.add(currentId);
  return compatible.find((server) => !attempted.has(server.id))?.id ?? null;
}

export function playbackSessionExhausted(
  servers: PlaybackServer[],
  mediaType: MediaItem['mediaType'],
  attemptedIds: Iterable<string>,
) {
  const compatible = serversForMedia(servers, mediaType);
  if (!compatible.length) return true;
  const attempted = new Set(attemptedIds);
  return compatible.every((server) => attempted.has(server.id));
}

export function providerEmitsPlaybackSignal(server?: PlaybackServer | null) {
  return server?.commandMode === 'cinesrc' || server?.commandMode === 'vidzen';
}

export function isProviderPlaybackSignal(raw: unknown) {
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!payload || typeof payload !== 'object') return false;
    const message = payload as {
      type?: unknown;
      event?: unknown;
      data?: { event?: unknown };
    };
    if (typeof message.type === 'string' && message.type.startsWith('cinesrc:')) {
      return ['ready', 'play', 'pause', 'seeked', 'timeupdate', 'ended'].includes(message.type.slice('cinesrc:'.length));
    }
    const eventName = message.type === 'mplayer' ? message.event : message.data?.event;
    return (message.type === 'PLAYER_EVENT' || message.type === 'mplayer')
      && ['ready', 'play', 'pause', 'seeked', 'timeupdate', 'ended'].includes(String(eventName));
  } catch {
    return false;
  }
}
