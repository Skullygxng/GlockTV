import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PPV_CATALOG_CACHE_KEY,
  PPV_CATALOG_CACHE_MAX_AGE_MS,
  aggregatePpvCatalog,
  mergePpvEvents,
  ppvIdentityKey,
  readPpvCatalogCache,
  streamedCatalogProvider,
  writePpvCatalogCache,
} from '../src/lib/ppvCatalogAggregator';
import {
  THESPORTSDB_API,
  loadTheSportsDbCatalog,
  mapSportsDbEvent,
  theSportsDbCatalogProvider,
  thesportsdbCategory,
  thesportsdbStartMs,
} from '../src/lib/ppvTheSportsDb';
import { PpvCatalogError, isCombatPpvRow, loadPpvCatalog, type PpvEvent } from '../src/lib/ppv';
import type { PpvCatalogProvider } from '../src/lib/ppvProviders';

const SOON = Date.now() + 3_600_000;
const STREAMED = 'https://streamed.pk';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* An in-memory Storage stand-in; jsdom localStorage is not used by these. */
function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    size: () => store.size,
  };
}

function sportsDbRow(overrides: Record<string, unknown> = {}) {
  return {
    idEvent: '2000001',
    idLeague: '4443',
    strEvent: 'UFC 400: Jones vs Aspinall',
    strSport: 'Fighting',
    strLeague: 'Ultimate Fighting Championship',
    strTimestamp: new Date(SOON).toISOString().replace('Z', '').slice(0, 19),
    strHomeTeam: 'Jon Jones',
    strAwayTeam: 'Tom Aspinall',
    ...overrides,
  };
}

function sportsDbFetch(rowsByDay: Record<string, unknown> | unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith(THESPORTSDB_API)) return json({}, 404);
    if (Array.isArray(rowsByDay)) return json({ events: rowsByDay });
    const day = new URL(url).searchParams.get('d') ?? '';
    return json({ events: rowsByDay[day] ?? null });
  }) as unknown as typeof fetch;
}

function stubProvider(
  id: 'streamed' | 'thesportsdb',
  events: PpvEvent[],
  status: 'success' | 'network_or_cors_error' = 'success',
): PpvCatalogProvider {
  return {
    id,
    label: id,
    load: async () => ({
      events,
      diagnostics: {
        stage: 'catalog_provider',
        providerId: id,
        status,
        endpoints: [],
        requestCount: 1,
        completedRequests: status === 'success' ? 1 : 0,
        httpStatuses: [],
        returnedRowCount: events.length,
        admittedEvents: events.length,
        rejectedNonCombat: 0,
        malformedRowCount: 0,
      },
    }),
  };
}

function event(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'streamed',
    providerEventId: 'ufc-400',
    title: 'UFC 400: Jones vs Aspinall',
    category: 'mma',
    startsAt: new Date(SOON).toISOString(),
    status: 'upcoming',
    sourceRefs: [],
    embeds: [],
    ...overrides,
  };
}

/* --- A/B: one provider down, the other carries the catalog ---------------- */

describe('A. catalog survives a single provider failure', () => {
  it('renders TheSportsDB events when Streamed is unreachable', async () => {
    const catalog = await aggregatePpvCatalog({
      providers: [
        stubProvider('thesportsdb', [event({ provider: 'thesportsdb', providerEventId: 'thesportsdb:1' })]),
        stubProvider('streamed', [], 'network_or_cors_error'),
      ],
      storage: null,
    });

    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.contributingProviders).toEqual(['thesportsdb']);
    expect(catalog.diagnostics?.failedProviders).toEqual(['streamed']);
    expect(catalog.diagnostics?.overallStatus).toBe('success');
  });

  it('B. renders Streamed events when TheSportsDB is unreachable', async () => {
    const catalog = await aggregatePpvCatalog({
      providers: [
        stubProvider('thesportsdb', [], 'network_or_cors_error'),
        stubProvider('streamed', [event()]),
      ],
      storage: null,
    });

    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.contributingProviders).toEqual(['streamed']);
    expect(catalog.source).toBe('streamed');
  });

  it('a provider that throws is reported, never propagated', async () => {
    const exploding: PpvCatalogProvider = {
      id: 'streamed',
      label: 'streamed',
      load: async () => {
        throw new Error('https://streamed.pk/api/matches/fight blew up');
      },
    };
    const catalog = await aggregatePpvCatalog({
      providers: [stubProvider('thesportsdb', [event()]), exploding],
      storage: null,
    });
    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.failedProviders).toEqual(['streamed']);
  });
});

/* --- C/D/E: total failure, cache, and no permanent stale state ----------- */

describe('C-E. total catalog failure', () => {
  it('C. throws a diagnostics-carrying error when nothing answers and nothing is cached', async () => {
    const attempt = aggregatePpvCatalog({
      providers: [
        stubProvider('thesportsdb', [], 'network_or_cors_error'),
        stubProvider('streamed', [], 'network_or_cors_error'),
      ],
      storage: null,
    });

    let reason: unknown;
    await attempt.catch((error: unknown) => {
      reason = error;
    });

    expect(reason).toBeInstanceOf(PpvCatalogError);
    const failure = reason as PpvCatalogError;
    expect(failure.diagnostics.providers?.map((entry) => entry.providerId)).toEqual([
      'thesportsdb',
      'streamed',
    ]);
    expect(failure.diagnostics.normalizedEvents).toBe(0);
    expect(failure.diagnostics.fromCache).toBe(false);
    /* The message must stay generic: request errors name their URL. */
    expect(failure.message).not.toContain('https://');
  });

  it('D. serves the cached catalog with a stale marker when nothing answers', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event()], now - 60_000, storage);

    const catalog = await aggregatePpvCatalog({
      providers: [
        stubProvider('thesportsdb', [], 'network_or_cors_error'),
        stubProvider('streamed', [], 'network_or_cors_error'),
      ],
      storage,
      now,
    });

    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.fromCache).toBe(true);
    expect(catalog.diagnostics?.stale).toBe(true);
    expect(catalog.diagnostics?.cacheAgeMs).toBe(60_000);
  });

  it('E. discards a cache past its maximum age rather than serving it forever', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event()], now - PPV_CATALOG_CACHE_MAX_AGE_MS - 1, storage);

    await expect(
      aggregatePpvCatalog({
        providers: [stubProvider('streamed', [], 'network_or_cors_error')],
        storage,
        now,
      }),
    ).rejects.toBeInstanceOf(PpvCatalogError);
    /* Deleted, not merely refused: there is no permanent stale state. */
    expect(storage.getItem(PPV_CATALOG_CACHE_KEY)).toBeNull();
  });

  it('a successful load refreshes the cache; an empty one does not overwrite it', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    await aggregatePpvCatalog({ providers: [stubProvider('streamed', [event()])], storage, now });
    expect(readPpvCatalogCache(now, storage)?.events).toHaveLength(1);

    await aggregatePpvCatalog({ providers: [stubProvider('streamed', [])], storage, now });
    expect(readPpvCatalogCache(now, storage)?.events).toHaveLength(1);
  });

  it('survives storage that throws on every access', async () => {
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    const catalog = await aggregatePpvCatalog({
      providers: [stubProvider('streamed', [event()])],
      storage: hostile,
    });
    expect(catalog.events).toHaveLength(1);
  });

  it('rejects a corrupt cache entry instead of rendering it', () => {
    const storage = memoryStorage();
    storage.setItem(PPV_CATALOG_CACHE_KEY, '{not json');
    expect(readPpvCatalogCache(Date.now(), storage)).toBeNull();
    storage.setItem(PPV_CATALOG_CACHE_KEY, JSON.stringify({ savedAt: 'soon', events: [] }));
    expect(readPpvCatalogCache(Date.now(), storage)).toBeNull();
  });
});

/* --- F: identity and dedupe --------------------------------------------- */

describe('F. normalized identity and dedupe', () => {
  it('merges the same event reported by two providers into one row', async () => {
    const day = new Date(SOON).toISOString();
    const fromSportsDb = event({
      provider: 'thesportsdb',
      providerEventId: 'thesportsdb:2000001',
      providerRefs: { thesportsdb: { eventId: '2000001' } },
      participants: ['Jon Jones', 'Tom Aspinall'],
      startsAt: day,
    });
    const fromStreamed = event({
      provider: 'streamed',
      providerEventId: 'ufc-400',
      providerRefs: { streamed: { eventId: 'ufc-400' } },
      participants: ['Tom Aspinall', 'Jon Jones'],
      startsAt: day,
      sourceRefs: [{ source: 'delta', id: 'ufc-400-d' }],
    });

    const catalog = await aggregatePpvCatalog({
      providers: [
        stubProvider('thesportsdb', [fromSportsDb]),
        stubProvider('streamed', [fromStreamed]),
      ],
      storage: null,
    });

    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.mergedDuplicates).toBe(1);
    expect(catalog.events[0].catalogProvenance?.providers).toEqual(['thesportsdb', 'streamed']);
    /* Provider-native identifiers stay under their own provider's key. */
    expect(catalog.events[0].providerRefs?.thesportsdb?.eventId).toBe('2000001');
    expect(catalog.events[0].providerRefs?.streamed?.eventId).toBe('ufc-400');
    expect(catalog.events[0].sourceRefs).toHaveLength(1);
    expect(catalog.source).toBe('aggregate');
  });

  it('keeps two different cards on the same night apart', () => {
    const a = event({ title: 'UFC 400', participants: ['Jon Jones', 'Tom Aspinall'] });
    const b = event({ title: 'UFC Fight Night', participants: ['Alex Pereira', 'Magomed Ankalaev'] });
    expect(ppvIdentityKey(a)).not.toBe(ppvIdentityKey(b));
  });

  it('does not merge across categories or across calendar days', () => {
    const base = event({ participants: ['A Fighter', 'B Fighter'] });
    expect(ppvIdentityKey(base)).not.toBe(ppvIdentityKey({ ...base, category: 'boxing' }));
    expect(ppvIdentityKey(base)).not.toBe(
      ppvIdentityKey({ ...base, startsAt: new Date(SOON + 86_400_000).toISOString() }),
    );
  });

  it('never lets a thinner duplicate erase richer metadata', () => {
    const rich = event({
      promotion: 'UFC',
      participants: ['Jon Jones', 'Tom Aspinall'],
      officialWatchUrl: 'https://www.ufc.com/events',
      sourceRefs: [{ source: 'delta', id: 'a' }],
    });
    const thin = event({ title: 'UFC 400', promotion: undefined, participants: undefined });
    const merged = mergePpvEvents(rich, thin);
    expect(merged.promotion).toBe('UFC');
    expect(merged.participants).toEqual(['Jon Jones', 'Tom Aspinall']);
    expect(merged.officialWatchUrl).toBe('https://www.ufc.com/events');
    expect(merged.sourceRefs).toHaveLength(1);
  });

  it('promotes live when either provider reports live', () => {
    const merged = mergePpvEvents(event({ status: 'upcoming' }), event({ status: 'live' }));
    expect(merged.status).toBe('live');
  });
});

/* --- G: combat-only admission, adversarially ---------------------------- */

describe('G. combat-only admission', () => {
  it('rejects a football event whose identifier is ppv-prefixed', () => {
    expect(isCombatPpvRow('Chiefs vs Ravens', 'american-football')).toBe(false);
    expect(isCombatPpvRow('Alabama vs Georgia', 'football')).toBe(false);
    /* Even with no upstream category at all, "ppv" alone is not evidence. */
    expect(isCombatPpvRow('Chiefs vs Ravens', '')).toBe(false);
    expect(isCombatPpvRow('PPV: Chiefs vs Ravens', '')).toBe(false);
  });

  it('rejects a football row from the Streamed catalog end to end', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/fight')) {
        return json([
          { id: 'ufc-400', title: 'UFC 400', category: 'fight', date: SOON },
          { id: 'ppv-nfl-week-1', title: 'Chiefs vs Ravens', category: 'american-football', date: SOON },
          { id: 'ppv-cfb-final', title: 'Alabama vs Georgia', category: 'football', date: SOON },
        ]);
      }
      return json([]);
    }) as unknown as typeof fetch;

    const catalog = await loadPpvCatalog(request);
    expect(catalog.events.map((entry) => entry.providerEventId)).toEqual(['ufc-400']);
  });

  it('still admits what the provider itself calls a fight', () => {
    expect(isCombatPpvRow('Synthetic Unrelated Matchup', 'fight')).toBe(true);
    expect(isCombatPpvRow('Anything At All', 'FIGHT')).toBe(true);
  });

  it('admits combat evidence in the title when the category is absent or unknown', () => {
    expect(isCombatPpvRow('UFC 400: Jones vs Aspinall', '')).toBe(true);
    expect(isCombatPpvRow('Canelo vs Crawford Championship Boxing', 'ppv')).toBe(true);
    expect(isCombatPpvRow('Cage Warriors 180 Fight Night', undefined)).toBe(true);
    expect(isCombatPpvRow('WWE SmackDown', null)).toBe(true);
  });

  it('does not let a title guess override an explicit non-combat category', () => {
    expect(isCombatPpvRow('The Heavyweight Derby', 'soccer')).toBe(false);
    expect(isCombatPpvRow('Boxing Day Fixture', 'football')).toBe(false);
  });

  it('rejects a non-combat sport from TheSportsDB even when it looks like a fight', () => {
    expect(mapSportsDbEvent(sportsDbRow({ strSport: 'Soccer' }))).toBeNull();
    expect(mapSportsDbEvent(sportsDbRow({ strSport: 'American Football' }))).toBeNull();
  });
});

/* --- H: TheSportsDB normalization --------------------------------------- */

describe('H. TheSportsDB normalization', () => {
  it('normalizes a documented event row into the existing PpvEvent shape', () => {
    const mapped = mapSportsDbEvent(sportsDbRow());
    expect(mapped).not.toBeNull();
    expect(mapped?.provider).toBe('thesportsdb');
    expect(mapped?.providerEventId).toBe('thesportsdb:2000001');
    expect(mapped?.providerRefs?.thesportsdb).toEqual({ eventId: '2000001', leagueId: '4443' });
    expect(mapped?.category).toBe('mma');
    expect(mapped?.promotion).toBe('UFC');
    expect(mapped?.participants).toEqual(['Jon Jones', 'Tom Aspinall']);
    expect(mapped?.officialWatchUrl).toBe('https://www.ufc.com/events');
    /* Events display with no playback sources at all. That is not an error. */
    expect(mapped?.playbackSources).toEqual([]);
    expect(mapped?.embeds).toEqual([]);
  });

  it('never carries a third-party image URL onto the card', () => {
    const mapped = mapSportsDbEvent(
      sportsDbRow({ strThumb: 'https://www.thesportsdb.com/images/x.jpg', strPoster: 'https://x/y.jpg' }),
    );
    expect(mapped?.poster).toBeUndefined();
  });

  it('reads the documented UTC timestamp and the date/time fallback', () => {
    expect(thesportsdbStartMs({ strTimestamp: '2026-09-05T22:00:00' })).toBe(
      Date.parse('2026-09-05T22:00:00Z'),
    );
    expect(thesportsdbStartMs({ strTimestamp: '2026-09-05T22:00:00Z' })).toBe(
      Date.parse('2026-09-05T22:00:00Z'),
    );
    expect(thesportsdbStartMs({ dateEvent: '2026-09-05', strTime: '22:00:00' })).toBe(
      Date.parse('2026-09-05T22:00:00Z'),
    );
    expect(thesportsdbStartMs({ dateEvent: 'not-a-date' })).toBeNull();
    expect(thesportsdbStartMs({})).toBeNull();
  });

  it('derives the three filterable categories from the league name', () => {
    expect(thesportsdbCategory('Some Card', 'Professional Wrestling')).toBe('wrestling');
    expect(thesportsdbCategory('Some Card', 'World Boxing Council')).toBe('boxing');
    expect(thesportsdbCategory('Some Card', 'Glory Kickboxing')).toBe('mma');
    /* Unknown stays unknown rather than being guessed into a filter. */
    expect(thesportsdbCategory('Some Card', 'Unnamed Promotion')).toBe('other');
  });

  it('queries only the documented schedule endpoint with the published free key', async () => {
    const request = sportsDbFetch([sportsDbRow()]);
    await loadTheSportsDbCatalog(request);
    const urls = (request as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('https://www.thesportsdb.com/api/v1/json/123/eventsday.php?')).toBe(true);
      expect(new URL(url).searchParams.get('s')).toBe('Fighting');
      expect(new URL(url).searchParams.get('d')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('treats a day with no fixtures as a real empty answer, not a failure', async () => {
    const result = await loadTheSportsDbCatalog(sportsDbFetch({}));
    expect(result.events).toEqual([]);
    expect(result.diagnostics.status).toBe('empty_success');
    expect(result.diagnostics.completedRequests).toBeGreaterThan(0);
  });

  it('reports an unreachable provider as a failure, with no events', async () => {
    const request = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const result = await loadTheSportsDbCatalog(request);
    expect(result.events).toEqual([]);
    expect(result.diagnostics.status).toBe('network_or_cors_error');
    expect(result.diagnostics.completedRequests).toBe(0);
  });

  it('counts non-combat rows as rejected rather than dropping them silently', async () => {
    const result = await loadTheSportsDbCatalog(
      sportsDbFetch([sportsDbRow(), sportsDbRow({ idEvent: '9', strSport: 'Soccer' })]),
    );
    expect(result.diagnostics.rejectedNonCombat).toBeGreaterThan(0);
    expect(result.events.every((entry) => entry.category !== 'other' || entry.title)).toBe(true);
  });

  it('survives a malformed payload without discarding the other days', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const day = new URL(String(input)).searchParams.get('d') ?? '';
      const today = new Date().toISOString().slice(0, 10);
      return day === today ? json({ events: 'not-an-array' }) : json({ events: [sportsDbRow()] });
    }) as unknown as typeof fetch;

    const result = await loadTheSportsDbCatalog(request);
    expect(result.events).toHaveLength(1);
    expect(result.diagnostics.malformedRowCount).toBeGreaterThan(0);
  });

  it('exposes itself as a catalog provider with a stable identity', () => {
    expect(theSportsDbCatalogProvider.id).toBe('thesportsdb');
    expect(streamedCatalogProvider.id).toBe('streamed');
  });
});

/* --- Streamed as a provider: its rejection becomes a report -------------- */

describe('streamed catalog provider', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('converts a required-feed failure into a reported provider failure', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) =>
      String(input).startsWith(STREAMED) && String(input).endsWith('/fight')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : json([]),
    ) as unknown as typeof fetch;

    const result = await streamedCatalogProvider.load(request);
    expect(result.events).toEqual([]);
    expect(result.diagnostics.status).toBe('network_or_cors_error');
    expect(result.diagnostics.endpoints.map((entry) => entry.name)).toEqual([
      'fight',
      'live',
      'today',
    ]);
  });

  it('reports per-endpoint HTTP status when the feed answers with an error', async () => {
    const request = vi.fn(async () => json({}, 503)) as unknown as typeof fetch;
    const result = await streamedCatalogProvider.load(request);
    expect(result.diagnostics.httpStatuses).toContain(503);
  });
});
