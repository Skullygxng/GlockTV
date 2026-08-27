export interface LiveStreamSource {
  url: string;
  quality: string | null;
  label: string | null;
}

export interface LiveChannel {
  id: string;
  name: string;
  displayName: string;
  logo: string | null;
  category: string;
  categories: string[];
  country: string;
  streams: LiveStreamSource[];
  metadata: string[];
}

export interface LiveTvCatalog {
  channels: LiveChannel[];
  source: 'iptv-org';
  loadedAt: string;
}

export const IPTV_ORG_US_PLAYLIST = 'https://iptv-org.github.io/iptv/countries/us.m3u';

export const PREFERRED_CATEGORIES = [
  'News',
  'Sports',
  'Movies',
  'Entertainment',
  'Series',
  'Kids',
  'Music',
  'Documentary',
  'Lifestyle',
  'Education',
  'Religious',
  'General',
] as const;

const CACHE_KEY = 'glocktv:live-catalog:v1';
const CACHE_TTL_MS = 20 * 60 * 1000;

interface CachedCatalog {
  catalog: LiveTvCatalog;
  expiresAt: number;
}

let memoryCache: CachedCatalog | null = null;

interface PendingEntry {
  id: string;
  name: string;
  logo: string | null;
  categoryRaw: string;
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

export function normalizeCategories(value: string | undefined): string[] {
  if (!value?.trim()) return ['General'];
  const parts = value
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/\s*\[geo-blocked\]/gi, '').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result.length ? result : ['General'];
}

export function pickPrimaryCategory(categories: string[]): string {
  if (!categories.length) return 'General';
  for (const preferred of PREFERRED_CATEGORIES) {
    const match = categories.find((c) => c.toLowerCase() === preferred.toLowerCase());
    if (match) return match;
  }
  return categories[0];
}

export function cleanChannelName(raw: string): { displayName: string; metadata: string[]; quality: string | null } {
  let name = raw.trim();
  const metadata: string[] = [];
  let quality: string | null = null;
  const bracketRe = /\s*\[([^\]]+)\]\s*$/i;
  let bracketMatch: RegExpExecArray | null;
  while ((bracketMatch = bracketRe.exec(name))) {
    const tag = bracketMatch[1].trim();
    if (tag) metadata.push(tag);
    name = name.slice(0, bracketMatch.index).trim();
  }
  const qualityRe = /\s*\(((?:\d{3,4}p)|SD|HD|FHD|UHD|4K|8K)\)\s*$/i;
  const qualityMatch = qualityRe.exec(name);
  if (qualityMatch) {
    quality = qualityMatch[1];
    metadata.push(qualityMatch[1]);
    name = name.slice(0, qualityMatch.index).trim();
  }
  name = name.replace(/\s{2,}/g, ' ').trim() || raw.trim();
  return { displayName: name, metadata, quality };
}

export function isBrowserSafeUrl(value: string): boolean {
  if (!value || value.includes('|')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const href = url.href.toLowerCase();
  const host = url.hostname.toLowerCase();
  const proxyHints = ['corsproxy', 'cors-anywhere', 'allorigins', 'thingproxy', 'yacdn.org', 'proxy.cors', 'api.allorigins'];
  if (proxyHints.some((hint) => host.includes(hint) || href.includes(hint))) return false;
  const path = url.pathname.toLowerCase();
  if (path.endsWith('.m3u8') || path.includes('.m3u8/')) return true;
  const hlsPathHints = [/\/(index|playlist|master|live|stream|hls)(\/|\.|$)/i, /\/chunklist/i, /\/manifest/i];
  if (hlsPathHints.some((re) => re.test(path))) return true;
  return false;
}

function looksBlocked(name: string, categoryRaw: string) {
  const text = `${name} ${categoryRaw}`.toLowerCase();
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
      pending = { id, name, logo: attrs.get('tvg-logo')?.trim() || null, categoryRaw: attrs.get('group-title')?.trim() || '', referrer: null, userAgent: null };
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
    if (!isBrowserSafeUrl(line) || current.referrer || current.userAgent || looksBlocked(current.name, current.categoryRaw)) continue;
    const categories = normalizeCategories(current.categoryRaw);
    const category = pickPrimaryCategory(categories);
    const { displayName, metadata, quality } = cleanChannelName(current.name);
    const source: LiveStreamSource = { url: line, quality, label: metadata.length ? metadata.join(', ') : null };
    const existing = channels.get(current.id);
    if (existing) {
      if (!existing.streams.some((stream) => stream.url === source.url)) existing.streams.push(source);
      for (const cat of categories) {
        if (!existing.categories.some((c) => c.toLowerCase() === cat.toLowerCase())) existing.categories.push(cat);
      }
      continue;
    }
    channels.set(current.id, { id: current.id, name: current.name, displayName, logo: current.logo, category, categories, country, streams: [source], metadata });
  }
  return { channels: [...channels.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)), source: 'iptv-org', loadedAt: new Date().toISOString() };
}

function readPersistedCache(): CachedCatalog | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCatalog;
    if (!parsed || typeof parsed.expiresAt !== 'number' || !parsed.catalog || !Array.isArray(parsed.catalog.channels) || parsed.catalog.channels.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePersistedCache(entry: CachedCatalog) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* optional */
  }
}

export function clearIptvOrgCatalogCache() {
  memoryCache = null;
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

export async function loadIptvOrgCatalog(
  fetcher: typeof fetch = fetch,
  playlistUrl = IPTV_ORG_US_PLAYLIST,
  options: { bypassCache?: boolean } = {},
): Promise<LiveTvCatalog> {
  const now = Date.now();
  if (!options.bypassCache) {
    if (memoryCache && memoryCache.expiresAt > now && memoryCache.catalog.channels.length > 0) return memoryCache.catalog;
    const persisted = readPersistedCache();
    if (persisted && persisted.expiresAt > now && persisted.catalog.channels.length > 0) {
      memoryCache = persisted;
      return persisted.catalog;
    }
  }
  const response = await fetcher(playlistUrl, {
    headers: { Accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain' },
  });
  if (!response.ok) throw new Error(`IPTV-org returned ${response.status}`);
  const playlist = await response.text();
  const catalog = parseIptvOrgPlaylist(playlist);
  if (!catalog.channels.length) throw new Error('No browser-compatible IPTV-org channels were found.');
  const entry: CachedCatalog = { catalog, expiresAt: now + CACHE_TTL_MS };
  memoryCache = entry;
  writePersistedCache(entry);
  return catalog;
}

export function defaultLoadCatalog() {
  return loadIptvOrgCatalog();
}

export function refreshIptvOrgCatalog(fetcher: typeof fetch = fetch) {
  clearIptvOrgCatalogCache();
  return loadIptvOrgCatalog(fetcher, IPTV_ORG_US_PLAYLIST, { bypassCache: true });
}

export function categoryLabel(category: string) {
  return category.replace(/[-_]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
