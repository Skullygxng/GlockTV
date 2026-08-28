export type PpvCategory = 'boxing' | 'mma' | 'wrestling' | 'other';
export type PpvStatus = 'upcoming' | 'live' | 'ended';
export type PpvProviderId = 'streamed' | 'sportsrc' | 'daddylive';

export interface PpvEmbed {
  provider: PpvProviderId;
  id?: string;
  source?: string;
  language?: string;
  hd?: boolean;
  url: string;
}

export interface PpvEvent {
  provider: PpvProviderId;
  providerEventId: string;
  title: string;
  category: PpvCategory;
  promotion?: string;
  participants?: string[];
  startsAt: string;
  status: PpvStatus;
  poster?: string;
  sourceRefs: { source: string; id: string }[];
  embeds: PpvEmbed[];
}

export interface PpvCatalog {
  events: PpvEvent[];
  source: 'streamed';
  loadedAt: string;
}

export const STREAMED_API = 'https://streamed.pk';
export const SPORTSRC_API = 'https://api.sportsrc.org';
export const DADDYLIVE_EVENTS_API = 'https://daddylive.app/api/events';

const STALE_BEFORE_MS = 12 * 60 * 60 * 1000;
const LIVE_WINDOW_BEFORE_MS = 15 * 60 * 1000;
const LIVE_WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;

type FetchLike = typeof fetch;

interface StreamedTeam {
  name?: string | null;
  badge?: string | null;
}

interface StreamedMatch {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  date?: unknown;
  poster?: unknown;
  popular?: unknown;
  teams?: { home?: StreamedTeam; away?: StreamedTeam } | null;
  sources?: { source?: unknown; id?: unknown }[] | null;
}

interface StreamedStream {
  id?: unknown;
  streamNo?: unknown;
  language?: unknown;
  hd?: unknown;
  embedUrl?: unknown;
  source?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isHostedEmbedUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.pathname.toLowerCase().endsWith('.m3u8')) return false;
    if (url.search.toLowerCase().includes('.m3u8')) return false;
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function classifyPpvCategory(title: string, id = ''): PpvCategory {
  const haystack = `${title} ${id}`.toLowerCase();
  if (/\b(wwe|aew|njpw|impact|tna|wrestling|smackdown|raw|collision|nxt)\b/.test(haystack)) {
    return 'wrestling';
  }
  if (/\b(box|boxing|dazn|matchroom)\b/.test(haystack)) return 'boxing';
  if (/\b(ufc|mma|lfa|pfl|bellator|one friday|one championship|contender series|road to ufc)\b/.test(haystack)) {
    return 'mma';
  }
  return 'other';
}

export function inferPromotion(title: string): string | undefined {
  const haystack = title.toLowerCase();
  if (haystack.includes('ufc')) return 'UFC';
  if (haystack.includes('wwe')) return 'WWE';
  if (haystack.includes('aew')) return 'AEW';
  if (haystack.includes('lfa')) return 'LFA';
  if (haystack.includes('pfl')) return 'PFL';
  if (haystack.includes('one friday') || haystack.includes('one championship')) return 'ONE';
  if (haystack.includes('boxing')) return 'Boxing';
  return undefined;
}

export function derivePpvStatus(startsAtMs: number, now = Date.now(), liveIds?: Set<string>, eventId?: string): PpvStatus {
  if (eventId && liveIds?.has(eventId)) return 'live';
  if (startsAtMs > now + LIVE_WINDOW_BEFORE_MS) return 'upcoming';
  if (startsAtMs >= now - LIVE_WINDOW_AFTER_MS) return 'live';
  return 'ended';
}

export function streamedPosterUrl(poster: unknown): string | undefined {
  const value = asString(poster);
  if (!value) return undefined;
  if (value.startsWith('https://')) return value;
  if (value.startsWith('/')) return `${STREAMED_API}${value}`;
  return `${STREAMED_API}/api/images/proxy/${value}.webp`;
}

function participantsFrom(match: StreamedMatch, title: string): string[] | undefined {
  const home = asString(match.teams?.home?.name);
  const away = asString(match.teams?.away?.name);
  if (home && away) return [home, away];
  const vs = title.split(/\s+vs\.?\s+/i).map((part) => part.trim()).filter(Boolean);
  return vs.length === 2 ? vs : undefined;
}

export function mapStreamedMatch(match: StreamedMatch, liveIds?: Set<string>, now = Date.now()): PpvEvent | null {
  const id = asString(match.id);
  const title = asString(match.title);
  const date = asNumber(match.date);
  if (!id || !title || date == null) return null;
  if (date < now - STALE_BEFORE_MS && !liveIds?.has(id)) return null;

  const sources = (match.sources ?? [])
    .map((source) => ({ source: asString(source.source), id: asString(source.id) }))
    .filter((source) => source.source && source.id);

  return {
    provider: 'streamed',
    providerEventId: id,
    title,
    category: classifyPpvCategory(title, id),
    promotion: inferPromotion(title),
    participants: participantsFrom(match, title),
    startsAt: new Date(date).toISOString(),
    status: derivePpvStatus(date, now, liveIds, id),
    poster: streamedPosterUrl(match.poster),
    sourceRefs: sources,
    embeds: [],
  };
}

function sourceRank(source?: string): number {
  const value = (source ?? '').toLowerCase();
  if (value === 'admin') return 80;
  if (value === 'delta' || value === 'echo') return 10;
  if (value === 'golf' || value === 'alpha' || value === 'bravo') return 20;
  return 40;
}

export function mergePpvEmbeds(embeds: PpvEmbed[]): PpvEmbed[] {
  const seen = new Set<string>();
  const next: PpvEmbed[] = [];
  for (const embed of embeds) {
    if (!isHostedEmbedUrl(embed.url)) continue;
    const key = embed.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(embed);
  }
  return next.sort((left, right) => sourceRank(left.source) - sourceRank(right.source));
}

async function fetchJson(url: string, request: FetchLike): Promise<unknown> {
  const response = await request(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

function asMatchList(value: unknown): StreamedMatch[] {
  return Array.isArray(value) ? value : [];
}

export async function loadPpvCatalog(request: FetchLike = fetch): Promise<PpvCatalog> {
  const [fight, live, today] = await Promise.all([
    fetchJson(`${STREAMED_API}/api/matches/fight`, request),
    fetchJson(`${STREAMED_API}/api/matches/live`, request).catch(() => []),
    fetchJson(`${STREAMED_API}/api/matches/all-today`, request).catch(() => []),
  ]);

  const liveMatches = asMatchList(live);
  const liveIds = new Set(liveMatches.map((match) => asString(match.id)).filter(Boolean));
  const merged = new Map<string, StreamedMatch>();

  for (const match of [...asMatchList(fight), ...liveMatches, ...asMatchList(today)]) {
    const id = asString(match.id);
    const title = asString(match.title);
    if (!id || !title) continue;
    const category = asString(match.category);
    const combat =
      category === 'fight' ||
      classifyPpvCategory(title, id) !== 'other' ||
      /\bppv\b|fight/i.test(`${id} ${title}`);
    if (!combat) continue;
    merged.set(id, match);
  }

  const events = [...merged.values()]
    .map((match) => mapStreamedMatch(match, liveIds))
    .filter((event): event is PpvEvent => Boolean(event))
    .filter((event) => event.status !== 'ended')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'live' ? -1 : 1;
      return Date.parse(left.startsAt) - Date.parse(right.startsAt);
    });

  return {
    events,
    source: 'streamed',
    loadedAt: new Date().toISOString(),
  };
}

function mapStreamedStreams(rows: unknown, fallbackSource?: string): PpvEmbed[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const stream = row as StreamedStream;
    const url = asString(stream.embedUrl);
    if (!isHostedEmbedUrl(url)) return [];
    return [
      {
        provider: 'streamed' as const,
        id: asString(stream.id) || undefined,
        source: asString(stream.source) || fallbackSource,
        language: asString(stream.language) || undefined,
        hd: typeof stream.hd === 'boolean' ? stream.hd : undefined,
        url,
      },
    ];
  });
}

async function loadStreamedEmbeds(event: PpvEvent, request: FetchLike): Promise<PpvEmbed[]> {
  const embeds: PpvEmbed[] = [];
  await Promise.all(
    event.sourceRefs.map(async (ref) => {
      try {
        const rows = await fetchJson(`${STREAMED_API}/api/stream/${encodeURIComponent(ref.source)}/${encodeURIComponent(ref.id)}`, request);
        embeds.push(...mapStreamedStreams(rows, ref.source));
      } catch {
        /* source-specific miss is fine */
      }
    }),
  );
  return embeds;
}

async function loadSportSrcEmbeds(event: PpvEvent, request: FetchLike): Promise<PpvEmbed[]> {
  try {
    const payload = (await fetchJson(
      `${SPORTSRC_API}/?data=detail&category=fight&id=${encodeURIComponent(event.providerEventId)}`,
      request,
    )) as { success?: boolean; data?: { sources?: StreamedStream[] } };
    const sources = payload?.data?.sources;
    if (!Array.isArray(sources)) return [];
    return sources.flatMap((stream) => {
      const url = asString(stream.embedUrl);
      if (!isHostedEmbedUrl(url)) return [];
      return [
        {
          provider: 'sportsrc' as const,
          id: asString(stream.id) || undefined,
          source: asString(stream.source) || undefined,
          language: asString(stream.language) || undefined,
          hd: typeof stream.hd === 'boolean' ? stream.hd : undefined,
          url,
        },
      ];
    });
  } catch {
    return [];
  }
}

function titlesOverlap(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const tokens = a.split(' ').filter((token) => token.length > 3);
  const hits = tokens.filter((token) => b.includes(token));
  return hits.length >= 2;
}

async function loadDaddyLiveEmbeds(event: PpvEvent, request: FetchLike): Promise<PpvEmbed[]> {
  try {
    const payload = (await fetchJson(DADDYLIVE_EVENTS_API, request)) as {
      categories?: Record<string, { event?: string; channels?: { channel_name?: string; url?: string }[] }[]>;
    };
    const categories = payload.categories ?? {};
    const embeds: PpvEmbed[] = [];
    for (const rows of Object.values(categories)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const title = asString(row.event);
        if (!titlesOverlap(event.title, title)) continue;
        for (const channel of row.channels ?? []) {
          const url = asString(channel.url);
          if (!isHostedEmbedUrl(url)) continue;
          embeds.push({
            provider: 'daddylive',
            id: asString(channel.channel_name) || undefined,
            source: 'daddylive',
            url,
          });
        }
      }
    }
    return embeds;
  } catch {
    return [];
  }
}

export async function loadPpvEmbeds(event: PpvEvent, request: FetchLike = fetch): Promise<PpvEmbed[]> {
  const streamed = await loadStreamedEmbeds(event, request);
  const sportsrc = await loadSportSrcEmbeds(event, request);
  let embeds = mergePpvEmbeds([...streamed, ...sportsrc]);
  if (!embeds.length) {
    embeds = mergePpvEmbeds(await loadDaddyLiveEmbeds(event, request));
  }
  return embeds;
}

export function formatPpvStart(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return 'Time TBA';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatPpvCountdown(startsAt: string, now = Date.now()): string {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return '';
  const delta = start - now;
  if (delta <= 0) return 'Live now';
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
