import type { MediaItem } from './media';

export interface PlaybackConfig {
  movieUrlTemplate?: string;
  tvUrlTemplate?: string;
  servers?: PlaybackServer[];
}

export type PlayerCommandMode = 'none' | 'vidzen' | 'cinesrc';

export interface PlaybackServer {
  id: string;
  label: string;
  description: string;
  movieUrlTemplate?: string;
  tvUrlTemplate?: string;
  commandMode?: PlayerCommandMode;
  startTimeParam?: string;
}

export interface PlaybackSelection {
  season?: number;
  episode?: number;
  startAt?: number;
}

const positiveInteger = (value: number | undefined) => (
  Number.isFinite(value) && Number.isInteger(value) && (value ?? 0) > 0 ? value! : 1
);

export function buildPlaybackUrl(
  item: Pick<MediaItem, 'id' | 'mediaType'>,
  config: PlaybackConfig,
  selection: PlaybackSelection = {},
  serverId?: string,
): string | null {
  const servers = getPlaybackServers(config);
  const server = servers.find((candidate) => candidate.id === serverId) ?? servers[0];
  const template = item.mediaType === 'movie' ? server?.movieUrlTemplate : server?.tvUrlTemplate;
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
    if (url.protocol !== 'https:') return null;
    if (Number.isFinite(selection.startAt) && (selection.startAt ?? 0) > 0) {
      url.searchParams.set(server?.startTimeParam ?? 'startAt', String(Math.floor(selection.startAt!)));
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function getPlaybackServers(config: PlaybackConfig): PlaybackServer[] {
  const candidates = config.servers?.length ? config.servers : [{
    id: 'primary',
    label: 'Primary provider',
    description: 'Automatic source fallback',
    movieUrlTemplate: config.movieUrlTemplate,
    tvUrlTemplate: config.tvUrlTemplate,
    commandMode: 'none' as const,
  }];
  const seen = new Set<string>();
  return candidates.filter((server) => {
    if (!server.id.trim() || seen.has(server.id)) return false;
    if (!server.movieUrlTemplate?.trim() && !server.tvUrlTemplate?.trim()) return false;
    seen.add(server.id);
    return true;
  });
}

export function getPlaybackConfig(): PlaybackConfig {
  const movieUrlTemplate = import.meta.env.VITE_MOVIE_EMBED_URL_TEMPLATE;
  const tvUrlTemplate = import.meta.env.VITE_TV_EMBED_URL_TEMPLATE;
  const backupMovie = import.meta.env.VITE_BACKUP_MOVIE_EMBED_URL_TEMPLATE;
  const backupTv = import.meta.env.VITE_BACKUP_TV_EMBED_URL_TEMPLATE;
  const cineSrcMovie = import.meta.env.VITE_CINESRC_MOVIE_EMBED_URL_TEMPLATE;
  const cineSrcTv = import.meta.env.VITE_CINESRC_TV_EMBED_URL_TEMPLATE;
  return { movieUrlTemplate, tvUrlTemplate, servers: [
    { id: 'cinesrc', label: 'CineSrc', description: 'Native fullscreen · PiP · alternate sources', movieUrlTemplate: cineSrcMovie, tvUrlTemplate: cineSrcTv, commandMode: 'cinesrc', startTimeParam: 't' },
    { id: 'auto', label: 'VidCore', description: 'Automatic source fallback · popup protected', movieUrlTemplate, tvUrlTemplate, commandMode: 'none' },
    { id: 'backup', label: 'VidZen Backup', description: 'Use when CineSrc or VidCore is slow', movieUrlTemplate: backupMovie, tvUrlTemplate: backupTv, commandMode: 'vidzen' },
  ] };
}
