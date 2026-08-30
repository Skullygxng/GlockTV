/*
 * Regressions for the four P1 defects found in the PR #14 red-team.
 *
 * Each block states the defect it locks down, because every one of them was a
 * case of the code claiming more than it could actually know.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { PpvPlayer } from '../src/components/PpvPlayer';
import { PpvPanel } from '../src/components/PpvPanel';
import type { PpvEvent } from '../src/lib/ppv';
import {
  PPV_CATALOG_CACHE_MAX_AGE_MS,
  aggregatePpvCatalog,
  writePpvCatalogCache,
} from '../src/lib/ppvCatalogAggregator';
import {
  THESPORTSDB_API,
  THESPORTSDB_DAY_WINDOW,
  loadTheSportsDbCatalog,
  mapSportsDbEvent,
  theSportsDbCatalogProvider,
} from '../src/lib/ppvTheSportsDb';
import { resolvePpvPlayback, youtubePlaybackProvider } from '../src/lib/ppvPlaybackRegistry';
import { youtubeVideoIdFrom } from '../src/lib/ppvAuthorizedEmbeds';
import { PPV_SOURCE_LOAD_DEADLINE_MS } from '../src/lib/ppvDiagnostics';
import { PpvCatalogError } from '../src/lib/ppv';
import type { PpvCatalogProvider } from '../src/lib/ppvProviders';

const SOON_MS = Date.now() + 3 * 3600_000;
const SOON_ISO = new Date(SOON_MS).toISOString();
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
}

function event(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'thesportsdb',
    providerEventId: 'thesportsdb:2000001',
    title: 'UFC 400: Jones vs Aspinall',
    category: 'mma',
    startsAt: SOON_ISO,
    status: 'upcoming',
    sourceRefs: [],
    embeds: [],
    ...overrides,
  };
}

function sportsDbRow(overrides: Record<string, unknown> = {}) {
  return {
    idEvent: '2000001',
    idLeague: '4443',
    strEvent: 'UFC 400: Jones vs Aspinall',
    strSport: 'Fighting',
    strLeague: 'Ultimate Fighting Championship',
    strTimestamp: new Date(SOON_MS).toISOString().replace('Z', '').slice(0, 19),
    strHomeTeam: 'Jon Jones',
    strAwayTeam: 'Tom Aspinall',
    /* Documented by TheSportsDB as YouTube *highlights* for the event. */
    strVideo: YT,
    ...overrides,
  };
}

const failingFetch = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

/* ====================================================================== */

describe('P1 #1. TheSportsDB highlight video is never a playback source', () => {
  it('does not turn strVideo into a YouTube playback reference', () => {
    const mapped = mapSportsDbEvent(sportsDbRow());
    expect(mapped).not.toBeNull();
    /* The event still loads - only the false playback claim is gone. */
    expect(mapped?.title).toBe('UFC 400: Jones vs Aspinall');
    expect(mapped?.providerRefs?.youtube).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toContain('dQw4w9WgXcQ');
  });

  it('resolves no YouTube source for an event carrying a highlight video', async () => {
    const mapped = mapSportsDbEvent(sportsDbRow()) as PpvEvent;
    const result = await resolvePpvPlayback(mapped, failingFetch);
    expect(result.sources).toEqual([]);
    expect(
      result.diagnostics.providers?.find((entry) => entry.stage === 'youtube')?.lookupState,
    ).toBe('not_attempted_unsupported');
    /* Falls through to the honest zero-source outcome, not a fake player. */
    expect(result.diagnostics.finalState).toBe('official_info_only');
  });

  it('surfaces the information state rather than a highlight reel in the player', async () => {
    const mapped = mapSportsDbEvent(sportsDbRow()) as PpvEvent;
    render(<PpvPlayer event={mapped} resolveSources={async () => resolvePpvPlayback(mapped, failingFetch)} />);
    expect(await screen.findByText('Official event information')).toBeInTheDocument();
    expect(screen.queryByText('Watch on official provider')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('end to end: a catalog load produces no youtube provider ref', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(THESPORTSDB_API)) return json({}, 404);
      const day = new URL(url).searchParams.get('d');
      const today = new Date().toISOString().slice(0, 10);
      return json({ events: day === today ? [sportsDbRow()] : null });
    }) as unknown as typeof fetch;

    const result = await loadTheSportsDbCatalog(request);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].providerRefs?.youtube).toBeUndefined();
  });

  it('keeps the YouTube adapter architecture intact for a real live embed reference', async () => {
    /*
     * The adapter is retained and still works when something explicitly hands
     * it a video identity. Nothing configured supplies one today, which is the
     * point: it is dormant, not deleted.
     */
    expect(youtubePlaybackProvider.id).toBe('youtube');
    expect(youtubeVideoIdFrom(YT)).toBe('dQw4w9WgXcQ');
    const result = await youtubePlaybackProvider.resolve(
      event({ providerRefs: { youtube: { videoId: 'dQw4w9WgXcQ' } } }),
      failingFetch,
    );
    expect(result.sources).toHaveLength(1);
  });
});

/* ====================================================================== */

describe('P1 #2. a general official page is never called a watch destination', () => {
  it('does not label a promotion information page as somewhere to watch', async () => {
    render(<PpvPlayer event={event({ officialInfoUrl: 'https://www.ufc.com/events' })} loadEmbeds={async () => []} />);
    expect(await screen.findByText('Official event information')).toBeInTheDocument();
    const player = screen.getByLabelText('PPV player').textContent ?? '';
    expect(player).not.toMatch(/watch/i);
    const link = screen.getByRole('link', { name: 'Open official page' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.ufc.com/events');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('still uses watch wording for a destination that really is one', async () => {
    render(
      <PpvPlayer
        event={event({ officialWatchUrl: 'https://www.dazn.com/en-US/fight/x' })}
        loadEmbeds={async () => []}
      />,
    );
    expect(await screen.findByText('Watch on official provider')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open official provider' })).toBeInTheDocument();
  });

  it('prefers the watch destination when an event somehow has both', async () => {
    render(
      <PpvPlayer
        event={event({
          officialWatchUrl: 'https://www.dazn.com/en-US/fight/x',
          officialInfoUrl: 'https://www.ufc.com/events',
        })}
        loadEmbeds={async () => []}
      />,
    );
    expect(await screen.findByText('Watch on official provider')).toBeInTheDocument();
    expect(screen.queryByText('Official event information')).not.toBeInTheDocument();
  });

  it('keeps the honest unavailable state when there is no destination at all', async () => {
    render(<PpvPlayer event={event()} loadEmbeds={async () => []} />);
    expect(await screen.findByText('Embed unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

/* ====================================================================== */

describe('P1 #3. exhausted failover is visible without debug mode', () => {
  afterEach(() => vi.useRealTimers());

  const twoSources = event({
    embeds: [
      { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' },
      { provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/b/' },
    ],
  });

  it('shows an explicit exhausted state to a normal user after the last error', () => {
    render(<PpvPlayer event={twoSources} />);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.streamapi.cc/sport/b/',
    );

    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    /* No wraparound, and the dead frame does not just sit there. */
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('No source loaded')).toBeInTheDocument();
    expect(screen.getByText('None of the available sources could be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry PPV sources' })).toBeInTheDocument();
    /* No debug panel was needed to learn any of that. */
    expect(screen.queryByLabelText('PPV runtime diagnostics')).not.toBeInTheDocument();
  });

  it('reaches the same state through the load deadline', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={twoSources} />);
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS + 50);
    });
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.streamapi.cc/sport/b/',
    );
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS + 50);
    });
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('No source loaded')).toBeInTheDocument();
  });

  it('never says video failed to play', () => {
    render(<PpvPlayer event={twoSources} />);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    const text = screen.getByLabelText('PPV player').textContent ?? '';
    expect(text).not.toMatch(/failed to play|did not play|playback failed|not playing/i);
  });

  it('offers the official destination alongside the exhausted state', () => {
    render(
      <PpvPlayer event={{ ...twoSources, officialInfoUrl: 'https://www.ufc.com/events' }} />,
    );
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    expect(screen.getByText('No source loaded')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open official page' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.ufc.com/events');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('still records exhaustion in the debug panel', () => {
    render(<PpvPlayer event={twoSources} debug />);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    expect(screen.getByLabelText('PPV runtime diagnostics').textContent ?? '').toMatch(
      /exhausted\s*true/i,
    );
  });

  it('a document load event still stops automatic failover', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={twoSources} />);
    fireEvent.load(document.querySelector('iframe') as HTMLIFrameElement);
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS * 3);
    });
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.st/embed/delta/a/1',
    );
    expect(screen.queryByText('No source loaded')).not.toBeInTheDocument();
  });

  it('a manual source choice keeps automatic failover disabled', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={twoSources} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next PPV source' }));
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS * 3);
    });
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.streamapi.cc/sport/b/',
    );
    expect(screen.queryByText('No source loaded')).not.toBeInTheDocument();
  });

  it('Retry sources re-resolves and puts a frame back', async () => {
    let calls = 0;
    render(
      <PpvPlayer
        event={twoSources}
        resolveSources={async (target) => {
          calls += 1;
          return resolvePpvPlayback({ ...target, sourceRefs: [] }, failingFetch);
        }}
      />,
    );
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    fireEvent.click(screen.getByRole('button', { name: 'Retry PPV sources' }));
    expect(await screen.findByText('Embed unavailable')).toBeInTheDocument();
    expect(calls).toBe(1);
  });
});

/* ====================================================================== */

describe('P1 #4. partial catalog coverage must not suppress last-known-good', () => {
  const today = new Date().toISOString().slice(0, 10);

  /* One day answers empty; the rest of the window never does. */
  function partialSportsDbFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(THESPORTSDB_API)) throw new TypeError('Failed to fetch');
      const day = new URL(url).searchParams.get('d');
      if (day !== today) throw new TypeError('Failed to fetch');
      return json({ events: null });
    }) as unknown as typeof fetch;
  }

  function completeEmptySportsDbFetch() {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(THESPORTSDB_API)) throw new TypeError('Failed to fetch');
      return json({ events: null });
    }) as unknown as typeof fetch;
  }

  const deadStreamed: PpvCatalogProvider = {
    id: 'streamed',
    label: 'streamed',
    load: async () => ({
      events: [],
      diagnostics: {
        stage: 'catalog_provider',
        providerId: 'streamed',
        status: 'network_or_cors_error',
        coverage: 'none',
        endpoints: [],
        requestCount: 3,
        completedRequests: 0,
        httpStatuses: [],
        returnedRowCount: 0,
        admittedEvents: 0,
        rejectedNonCombat: 0,
        malformedRowCount: 0,
      },
    }),
  };

  it('reports partial coverage when only part of the window answered', async () => {
    const result = await loadTheSportsDbCatalog(partialSportsDbFetch());
    expect(result.diagnostics.coverage).toBe('partial');
    expect(result.diagnostics.status).toBe('empty_success');
    expect(result.diagnostics.completedRequests).toBe(1);
    expect(result.diagnostics.requestCount).toBe(THESPORTSDB_DAY_WINDOW);
  });

  it('serves the warm cache when 1/5 days answered empty and everything else failed', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    const cachedEvents = [
      event({ providerEventId: 'cached-1', title: 'UFC 399', participants: ['A One', 'B Two'] }),
      event({ providerEventId: 'cached-2', title: 'Canelo vs Benavidez', category: 'boxing' }),
      event({ providerEventId: 'cached-3', title: 'AEW All Out', category: 'wrestling' }),
      event({ providerEventId: 'cached-4', title: 'ONE 170', participants: ['C Three', 'D Four'] }),
    ];
    writePpvCatalogCache(cachedEvents, now - 120_000, storage);

    const catalog = await aggregatePpvCatalog({
      providers: [theSportsDbCatalogProvider, deadStreamed],
      request: partialSportsDbFetch(),
      storage,
      now,
    });

    expect(catalog.events).toHaveLength(4);
    expect(catalog.diagnostics?.partialCoverage).toBe(true);
    expect(catalog.diagnostics?.stale).toBe(true);
    expect(catalog.diagnostics?.fromCache).toBe(true);
    const sportsdb = catalog.diagnostics?.providers?.find(
      (entry) => entry.providerId === 'thesportsdb',
    );
    expect(sportsdb?.coverage).toBe('partial');
    expect(
      catalog.diagnostics?.providers?.find((entry) => entry.providerId === 'streamed')?.coverage,
    ).toBe('none');
  });

  it('shows a partial notice and a retry in the panel for that exact case', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event({ providerEventId: 'cached-1', title: 'UFC 399' })], now - 120_000, storage);
    const request = partialSportsDbFetch();

    render(
      <PpvPanel
        loadCatalog={async () =>
          aggregatePpvCatalog({
            providers: [theSportsDbCatalogProvider, deadStreamed],
            request,
            storage,
            now,
          })
        }
      />,
    );

    expect(await screen.findByText('UFC 399')).toBeInTheDocument();
    expect(screen.getByText(/Some catalog sources did not answer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a partial result never becomes the new last-known-good', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    const original = [event({ providerEventId: 'cached-1', title: 'UFC 399' })];
    writePpvCatalogCache(original, now - 120_000, storage);
    const before = storage.getItem('glocktv.ppv.catalog.v1');

    await aggregatePpvCatalog({
      providers: [theSportsDbCatalogProvider, deadStreamed],
      request: partialSportsDbFetch(),
      storage,
      now,
    });

    expect(storage.getItem('glocktv.ppv.catalog.v1')).toBe(before);
  });

  it('keeps legitimate new events from a partial answer alongside the cache', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event({ providerEventId: 'cached-1', title: 'UFC 399' })], now - 60_000, storage);

    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith(THESPORTSDB_API)) throw new TypeError('Failed to fetch');
      const day = new URL(url).searchParams.get('d');
      if (day !== today) throw new TypeError('Failed to fetch');
      return json({ events: [sportsDbRow()] });
    }) as unknown as typeof fetch;

    const catalog = await aggregatePpvCatalog({
      providers: [theSportsDbCatalogProvider, deadStreamed],
      request,
      storage,
      now,
    });

    const titles = catalog.events.map((entry) => entry.title);
    expect(titles).toContain('UFC 399');
    expect(titles).toContain('UFC 400: Jones vs Aspinall');
    expect(catalog.diagnostics?.partialCoverage).toBe(true);
  });

  it('5/5 genuine empty days stays a real empty result and does not resurrect the cache', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event({ providerEventId: 'cached-1', title: 'UFC 399' })], now - 60_000, storage);

    const catalog = await aggregatePpvCatalog({
      providers: [theSportsDbCatalogProvider, deadStreamed],
      request: completeEmptySportsDbFetch(),
      storage,
      now,
    });

    expect(catalog.events).toEqual([]);
    expect(catalog.diagnostics?.partialCoverage).toBe(false);
    expect(catalog.diagnostics?.fromCache).toBe(false);
    expect(catalog.diagnostics?.stale).toBe(false);
    expect(catalog.diagnostics?.overallStatus).toBe('empty_success');
    expect(
      catalog.diagnostics?.providers?.find((entry) => entry.providerId === 'thesportsdb')?.coverage,
    ).toBe('complete');
  });

  it('still refuses a cache past the maximum age, partial coverage or not', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache(
      [event({ providerEventId: 'cached-1', title: 'UFC 399' })],
      now - PPV_CATALOG_CACHE_MAX_AGE_MS - 1,
      storage,
    );

    const catalog = await aggregatePpvCatalog({
      providers: [theSportsDbCatalogProvider, deadStreamed],
      request: partialSportsDbFetch(),
      storage,
      now,
    });
    expect(catalog.events).toEqual([]);
    expect(catalog.diagnostics?.fromCache).toBe(false);

    await expect(
      aggregatePpvCatalog({
        providers: [deadStreamed],
        request: failingFetch,
        storage,
        now,
      }),
    ).rejects.toBeInstanceOf(PpvCatalogError);
  });
});
