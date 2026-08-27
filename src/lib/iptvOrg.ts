export interface LiveStreamSource {
  url: string;
  quality: string | null;
  label: string | null;
}

export interface LiveChannel {
  id: string;
  name: string;
  logo: string | null;
  category: string;
  country: string;
  streams: LiveStreamSource[];
}

export interface LiveTvCatalog {
  channels: LiveChannel[];
  source: 'iptv-org';
  loadedAt: string;
}

export const IPTV_ORG_US_PLAYLIST = 'https://iptv-org.github.io/iptv/countries/us.m3u';

interface PendingEntry {
  id: string;
  name: string;
  logo: string | null;
  category: string;
  referrer: string | null;
  userAgent: string | null;
}

function parseAttributes(line: string) {
  const attributes = new Map<string, string>();
  const expression = /([\w-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(line))) attributes.set(match[1], match[2]);
  return attributes;
}

function normalizeCategory(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || 'General';
}

function isBrowserSafeUrl(value: string) {
  try {
    return !value.includes('|') && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function looksBlocked(name: string, category: string) {
  const text = `${name} ${category}`.toLowerCase();
  return text.includes('[geo-blocked]') || text.includes('geo-blocked');
}

export function parseIptvOrgPlaylist(text: string, country = 'US'): LiveTvCatalog {
  const lines = text.split(/\r?\n/);
  const channels = new Map<string, LiveChannel>();
  let pending: PendingEntry | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const attrs = parseAttributes(line);
      const commaIndex = line.lastIndexOf(',');
      const name = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : 'Unknown channel';
      const id = attrs.get('tvg-id')?.trim() || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${country.toLowerCase()}`;
      pending = {
        id,
        name,
        logo: attrs.get('tvg-logo')?.trim() || null,
        category: normalizeCategory(attrs.get('group-title')),
        referrer: null,
        userAgent: null,
      };
      continue;
    }

    if (!pending) continue;

    if (line.startsWith('#EXTVLCOPT:http-referrer=')) {
      pending.referrer = line.slice('#EXTVLCOPT:http-referrer='.length).trim() || null;
      continue;
    }

    if (line.startsWith('#EXTVLCOPT:http-user-agent=')) {
      pending.userAgent = line.slice('#EXTVLCOPT:http-user-agent='.length).trim() || null;
      continue;
    }

    if (line.startsWith('#')) continue;

    const current = pending;
    pending = null;
    if (!isBrowserSafeUrl(line) || current.referrer || current.userAgent || looksBlocked(current.name, current.category)) continue;

    const existing = channels.get(current.id);
    const source: LiveStreamSource = { url: line, quality: null, label: null };
    if (existing) {
      if (!existing.streams.some((stream) => stream.url === source.url)) existing.streams.push(source);
      continue;
    }

    channels.set(current.id, {
      id: current.id,
      name: current.name,
      logo: current.logo,
      category: current.category,
      country,
      streams: [source],
    });
  }

  return {
    channels: [...channels.values()].sort((left, right) => left.name.localeCompare(right.name)),
    source: 'iptv-org',
    loadedAt: new Date().toISOString(),
  };
}

export async function loadIptvOrgCatalog(
  fetcher: typeof fetch = fetch,
  playlistUrl = IPTV_ORG_US_PLAYLIST,
): Promise<LiveTvCatalog> {
  const response = await fetcher(playlistUrl, {
    headers: { Accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain' },
  });
  if (!response.ok) throw new Error(`IPTV-org returned ${response.status}`);
  const playlist = await response.text();
  const catalog = parseIptvOrgPlaylist(playlist);
  if (!catalog.channels.length) throw new Error('No browser-compatible IPTV-org channels were found.');
  return catalog;
}

export function categoryLabel(category: string) {
  return category
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
