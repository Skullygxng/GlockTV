import type { MediaItem } from './media';

export interface PlaybackConfig {
  movieUrlTemplate?: string;
  tvUrlTemplate?: string;
}

export interface PlaybackSelection {
  season?: number;
  episode?: number;
}

const positiveInteger = (value: number | undefined) => (
  Number.isFinite(value) && Number.isInteger(value) && (value ?? 0) > 0 ? value! : 1
);

export function buildPlaybackUrl(
  item: Pick<MediaItem, 'id' | 'mediaType'>,
  config: PlaybackConfig,
  selection: PlaybackSelection = {},
): string | null {
  const template = item.mediaType === 'movie' ? config.movieUrlTemplate : config.tvUrlTemplate;
  if (!template?.trim() || !template.includes('{tmdb_id}')) return null;
  if (item.mediaType === 'tv' && (!template.includes('{season_number}') || !template.includes('{episode_number}'))) return null;

  const replacements: Record<string, string> = {
    '{tmdb_id}': String(item.id),
    '{season_number}': String(positiveInteger(selection.season)),
    '{episode_number}': String(positiveInteger(selection.episode)),
  };
  const resolved = Object.entries(replacements).reduce(
    (url, [token, value]) => url.replaceAll(token, value),
    template.trim(),
  );
  if (/\{[^}]+\}/.test(resolved)) return null;

  try {
    const url = new URL(resolved);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function getPlaybackConfig(): PlaybackConfig {
  return {
    movieUrlTemplate: import.meta.env.VITE_MOVIE_EMBED_URL_TEMPLATE,
    tvUrlTemplate: import.meta.env.VITE_TV_EMBED_URL_TEMPLATE,
  };
}
