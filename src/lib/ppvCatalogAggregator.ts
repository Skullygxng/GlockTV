/*
 * PPV catalog aggregation.
 *
 * Several catalog providers run concurrently and their results are normalized,
 * merged and deduped into one catalog. The rules that matter:
 *
 *   - One provider failing while another succeeds renders the successful
 *     catalog. It is not a partial failure state, it is a catalog.
 *   - Every provider failing falls back to a short-lived local cache of the
 *     last good catalog, shown with a stale notice, before it is treated as a
 *     failure.
 *   - Every provider failing with no usable cache throws PpvCatalogError,
 *     carrying the per-provider diagnostics so the existing failure UI can
 *     still say what happened.
 *   - The cache has a hard maximum age. There is no permanent stale state:
 *     an entry past that age is deleted rather than served.
 */

import {
  PpvCatalogError,
  loadPpvCatalog,
  type PpvCatalog,
  type PpvEvent,
} from './ppv';
import {
  emptyCatalogProviderDiagnostics,
  type PpvCatalogDiagnostics,
  type PpvCatalogEndpointDiagnostics,
  type PpvCatalogProviderDiagnostics,
  type PpvCatalogProviderId,
  type PpvRequestStatus,
} from './ppvDiagnostics';
import { isAllowedOfficialWatchUrl } from './ppvOfficialWatch';
import { mergePpvPlaybackSources } from './ppvProviders';
import {
  settleCatalogProvider,
  type PpvCatalogProvider,
  type PpvCatalogProviderResult,
  type PpvFetchLike,
} from './ppvProviders';
import { theSportsDbCatalogProvider } from './ppvTheSportsDb';

const NOT_ATTEMPTED: PpvCatalogEndpointDiagnostics = {
  status: 'network_or_cors_error',
  httpStatus: null,
  rowCount: 0,
};

/*
 * Streamed as a catalog provider. Its loader already produces normalized
 * events and per-endpoint diagnostics; this only reshapes them and, crucially,
 * converts its rejection into a reported failure so it can no longer take the
 * whole catalog down with it.
 */
export const streamedCatalogProvider: PpvCatalogProvider = {
  id: 'streamed',
  label: 'Streamed',
  async load(request: PpvFetchLike): Promise<PpvCatalogProviderResult> {
    const diagnostics = emptyCatalogProviderDiagnostics('streamed');
    diagnostics.requestCount = 3;
    try {
      const catalog = await loadPpvCatalog(request);
      const feeds = catalog.diagnostics;
      if (feeds) {
        diagnostics.endpoints = [
          { ...feeds.fight, name: 'fight' },
          { ...feeds.live, name: 'live' },
          { ...feeds.today, name: 'today' },
        ];
        diagnostics.completedRequests = diagnostics.endpoints.filter(
          (entry) => entry.status === 'success' || entry.status === 'empty_success',
        ).length;
        diagnostics.returnedRowCount = diagnostics.endpoints.reduce(
          (total, entry) => total + entry.rowCount,
          0,
        );
        for (const entry of diagnostics.endpoints) {
          if (entry.httpStatus != null && !diagnostics.httpStatuses.includes(entry.httpStatus)) {
            diagnostics.httpStatuses.push(entry.httpStatus);
          }
        }
      }
      diagnostics.admittedEvents = catalog.events.length;
      diagnostics.status = catalog.events.length
        ? 'success'
        : (feeds?.overallStatus ?? 'empty_success');
      return { events: catalog.events, diagnostics };
    } catch (reason) {
      const feeds = reason instanceof PpvCatalogError ? reason.diagnostics : null;
      diagnostics.endpoints = [
        { ...(feeds?.fight ?? NOT_ATTEMPTED), name: 'fight' },
        { ...(feeds?.live ?? NOT_ATTEMPTED), name: 'live' },
        { ...(feeds?.today ?? NOT_ATTEMPTED), name: 'today' },
      ];
      for (const entry of diagnostics.endpoints) {
        if (entry.httpStatus != null && !diagnostics.httpStatuses.includes(entry.httpStatus)) {
          diagnostics.httpStatuses.push(entry.httpStatus);
        }
      }
      diagnostics.status = feeds?.fight.status ?? 'network_or_cors_error';
      return { events: [], diagnostics };
    }
  },
};

/*
 * TheSportsDB is listed first: it is the primary catalog, it is a documented
 * data API rather than a stream aggregator, and putting it first means a
 * Streamed outage costs the source ordering nothing.
 */
export const PPV_CATALOG_PROVIDERS: readonly PpvCatalogProvider[] = [
  theSportsDbCatalogProvider,
  streamedCatalogProvider,
];

/* --- normalized identity ------------------------------------------------ */

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/*
 * Deliberately conservative. Two providers describe the same event only when
 * they agree on who is fighting (or on the event name), on the calendar day,
 * and on the category. Start times drift between providers by minutes, so the
 * UTC day is the time component rather than the timestamp; anything tighter
 * would fail to merge real duplicates, and anything looser would merge two
 * different cards on the same night.
 */
export function ppvIdentityKey(event: PpvEvent): string {
  const participants = (event.participants ?? [])
    .map(normalizeName)
    .filter(Boolean)
    .sort();
  const who = participants.length >= 2 ? participants.join('|') : normalizeName(event.title);
  const day = event.startsAt.slice(0, 10);
  return `${event.category}::${day}::${who}`;
}

function richer(left: string | undefined, right: string | undefined): string | undefined {
  const a = left?.trim() ?? '';
  const b = right?.trim() ?? '';
  if (!a) return b || undefined;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

/*
 * Field-by-field union. A thinner duplicate can never erase metadata the first
 * provider already supplied, and provider-native identifiers stay under their
 * own provider's key - one provider's id is never handed to another.
 */
export function mergePpvEvents(base: PpvEvent, next: PpvEvent): PpvEvent {
  const providers = new Set<PpvCatalogProviderId>([
    ...(base.catalogProvenance?.providers ?? []),
    ...(next.catalogProvenance?.providers ?? []),
  ]);
  const upstream = new Set([
    ...(base.catalogProvenance?.upstreamCategories ?? []),
    ...(next.catalogProvenance?.upstreamCategories ?? []),
  ]);
  const feeds = new Set([
    ...(base.catalogProvenance?.feeds ?? []),
    ...(next.catalogProvenance?.feeds ?? []),
  ]);

  const sourceRefs = [...base.sourceRefs];
  for (const ref of next.sourceRefs) {
    const key = `${ref.source}|${ref.id}`.toLowerCase();
    if (!sourceRefs.some((entry) => `${entry.source}|${entry.id}`.toLowerCase() === key)) {
      sourceRefs.push(ref);
    }
  }

  return {
    ...base,
    title: richer(base.title, next.title) ?? base.title,
    promotion: base.promotion ?? next.promotion,
    participants: base.participants ?? next.participants,
    /* A provider reporting live outranks one that has not noticed yet. */
    status: base.status === 'live' || next.status === 'live' ? 'live' : base.status,
    poster: base.poster ?? next.poster,
    officialWatchUrl: base.officialWatchUrl ?? next.officialWatchUrl,
    providerRefs: { ...next.providerRefs, ...base.providerRefs },
    sourceRefs,
    embeds: base.embeds.length ? base.embeds : next.embeds,
    playbackSources: base.playbackSources?.length ? base.playbackSources : next.playbackSources,
    catalogProvenance: {
      feeds: [...feeds],
      upstreamCategories: [...upstream],
      providers: [...providers],
    },
  };
}

/* --- local cache -------------------------------------------------------- */

export const PPV_CATALOG_CACHE_KEY = 'glocktv.ppv.catalog.v1';
/*
 * Short by design. Past this age the entry is deleted instead of served, so a
 * long outage degrades to the honest failure UI rather than to a fight list
 * that is quietly hours out of date.
 */
export const PPV_CATALOG_CACHE_MAX_AGE_MS = 30 * 60_000;

interface CacheEntry {
  savedAt: number;
  events: PpvEvent[];
}

/*
 * Cached events are JSON that left our control. They are re-validated on the
 * way back in rather than trusted: anything that reaches an href or a src has
 * to pass the same policy it passed the first time, and a row missing the
 * fields the UI reads is dropped instead of rendered half-formed.
 */
function sanitizeCachedEvent(value: unknown): PpvEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<PpvEvent>;
  if (typeof row.providerEventId !== 'string' || !row.providerEventId) return null;
  if (typeof row.title !== 'string' || !row.title) return null;
  if (typeof row.startsAt !== 'string' || !Number.isFinite(Date.parse(row.startsAt))) return null;
  if (row.status !== 'live' && row.status !== 'upcoming' && row.status !== 'ended') return null;
  if (
    row.category !== 'mma' &&
    row.category !== 'boxing' &&
    row.category !== 'wrestling' &&
    row.category !== 'other'
  ) {
    return null;
  }

  const poster = typeof row.poster === 'string' && row.poster.startsWith('https://')
    ? row.poster
    : undefined;
  const official =
    typeof row.officialWatchUrl === 'string' && isAllowedOfficialWatchUrl(row.officialWatchUrl)
      ? row.officialWatchUrl
      : undefined;

  return {
    ...(row as PpvEvent),
    provider: row.provider ?? 'streamed',
    sourceRefs: Array.isArray(row.sourceRefs) ? row.sourceRefs : [],
    embeds: [],
    playbackSources: mergePpvPlaybackSources(
      Array.isArray(row.playbackSources) ? row.playbackSources : [],
    ),
    poster,
    officialWatchUrl: official,
  };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    /* Private mode and blocked storage both throw on access. */
    return null;
  }
}

export function writePpvCatalogCache(
  events: PpvEvent[],
  now = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PPV_CATALOG_CACHE_KEY, JSON.stringify({ savedAt: now, events }));
  } catch {
    /* A full or unavailable quota must never break a successful load. */
  }
}

export function readPpvCatalogCache(
  now = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): { events: PpvEvent[]; ageMs: number } | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(PPV_CATALOG_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let entry: CacheEntry | null = null;
  try {
    entry = JSON.parse(raw) as CacheEntry;
  } catch {
    entry = null;
  }
  const savedAt = typeof entry?.savedAt === 'number' ? entry.savedAt : NaN;
  const events = Array.isArray(entry?.events)
    ? entry.events.map(sanitizeCachedEvent).filter((row): row is PpvEvent => Boolean(row))
    : null;
  const ageMs = now - savedAt;
  if (!events || !Number.isFinite(savedAt) || ageMs < 0 || ageMs > PPV_CATALOG_CACHE_MAX_AGE_MS) {
    try {
      storage.removeItem(PPV_CATALOG_CACHE_KEY);
    } catch {
      /* Nothing to do; the age check above already refuses to serve it. */
    }
    return null;
  }
  return { events, ageMs };
}

/* --- aggregation -------------------------------------------------------- */

function endpointOf(
  providers: PpvCatalogProviderDiagnostics[],
  providerId: PpvCatalogProviderId,
  name: string,
): PpvCatalogEndpointDiagnostics {
  const entry = providers
    .find((provider) => provider.providerId === providerId)
    ?.endpoints.find((endpoint) => endpoint.name === name);
  return entry ?? { ...NOT_ATTEMPTED, name };
}

function aggregateStatus(
  providers: PpvCatalogProviderDiagnostics[],
  eventCount: number,
): PpvRequestStatus {
  if (eventCount > 0) return 'success';
  const answered = providers.filter(
    (provider) => provider.status === 'success' || provider.status === 'empty_success',
  );
  if (answered.length) return 'empty_success';
  return providers[0]?.status ?? 'network_or_cors_error';
}

export interface AggregatePpvCatalogOptions {
  providers?: readonly PpvCatalogProvider[];
  request?: PpvFetchLike;
  now?: number;
  storage?: StorageLike | null;
  /* Set false for a background refresh that must not overwrite a good cache. */
  useCache?: boolean;
}

export async function aggregatePpvCatalog(
  options: AggregatePpvCatalogOptions = {},
): Promise<PpvCatalog> {
  const providers = options.providers ?? PPV_CATALOG_PROVIDERS;
  const request = options.request ?? fetch;
  const now = options.now ?? Date.now();
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const useCache = options.useCache ?? true;
  const startedAt = now;

  const results = await Promise.all(
    providers.map((provider) =>
      settleCatalogProvider(
        provider,
        request,
        now,
        emptyCatalogProviderDiagnostics(provider.id),
      ),
    ),
  );

  const providerDiagnostics = results.map((result) => result.diagnostics);
  const contributing: PpvCatalogProviderId[] = [];
  const failed: PpvCatalogProviderId[] = [];
  for (const diagnostics of providerDiagnostics) {
    const answered = diagnostics.status === 'success' || diagnostics.status === 'empty_success';
    (answered ? contributing : failed).push(diagnostics.providerId);
  }

  const merged = new Map<string, PpvEvent>();
  let mergedDuplicates = 0;
  for (let index = 0; index < results.length; index += 1) {
    const providerId = providers[index].id;
    for (const event of results[index].events) {
      const stamped: PpvEvent = {
        ...event,
        catalogProvenance: {
          feeds: event.catalogProvenance?.feeds ?? [],
          upstreamCategories: event.catalogProvenance?.upstreamCategories ?? [],
          providers: [providerId],
        },
      };
      const key = ppvIdentityKey(stamped);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, stamped);
        continue;
      }
      mergedDuplicates += 1;
      merged.set(key, mergePpvEvents(existing, stamped));
    }
  }

  const events = [...merged.values()]
    .filter((event) => event.status !== 'ended')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'live' ? -1 : 1;
      return Date.parse(left.startsAt) - Date.parse(right.startsAt);
    });

  const base = {
    stage: 'catalog' as const,
    startedAt,
    completedAt: Date.now(),
    fight: endpointOf(providerDiagnostics, 'streamed', 'fight'),
    live: endpointOf(providerDiagnostics, 'streamed', 'live'),
    today: endpointOf(providerDiagnostics, 'streamed', 'today'),
    providers: providerDiagnostics,
    contributingProviders: contributing,
    failedProviders: failed,
    mergedDuplicates,
  };

  /*
   * At least one provider answered: that is a catalog, even if it is empty.
   * The other provider's failure is recorded, not promoted into an error.
   */
  if (contributing.length) {
    if (events.length) writePpvCatalogCache(events, now, storage);
    const diagnostics: PpvCatalogDiagnostics = {
      ...base,
      normalizedEvents: events.length,
      overallStatus: aggregateStatus(providerDiagnostics, events.length),
      fromCache: false,
      stale: false,
      cacheAgeMs: null,
    };
    return {
      events,
      source: contributing.length > 1 ? 'aggregate' : contributing[0],
      loadedAt: new Date(now).toISOString(),
      diagnostics,
    };
  }

  const cached = useCache ? readPpvCatalogCache(now, storage) : null;
  if (cached?.events.length) {
    const diagnostics: PpvCatalogDiagnostics = {
      ...base,
      normalizedEvents: cached.events.length,
      overallStatus: aggregateStatus(providerDiagnostics, 0),
      fromCache: true,
      stale: true,
      cacheAgeMs: cached.ageMs,
    };
    return {
      events: cached.events.filter((event) => event.status !== 'ended'),
      source: 'aggregate',
      loadedAt: new Date(now - cached.ageMs).toISOString(),
      diagnostics,
    };
  }

  throw new PpvCatalogError({
    ...base,
    normalizedEvents: 0,
    overallStatus: aggregateStatus(providerDiagnostics, 0),
    fromCache: false,
    stale: false,
    cacheAgeMs: null,
  });
}

/* Drop-in replacement for loadPpvCatalog at the UI boundary. */
export async function loadPpvPlatformCatalog(request: PpvFetchLike = fetch): Promise<PpvCatalog> {
  return aggregatePpvCatalog({ request });
}
