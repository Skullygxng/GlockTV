/*
 * Poster privacy.
 *
 * A poster URL is provider-controlled and lands in an <img src>, which the
 * browser fetches automatically when the event list renders - before the
 * viewer has chosen anything. These lock down the rule that only a
 * deliberately approved image origin is ever requested, and that refusing a
 * poster costs the event nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PpvPanel } from '../src/components/PpvPanel';
import theSportsDbSource from '../src/lib/ppvTheSportsDb.ts?raw';
import embedPolicySource from '../src/lib/ppvEmbedPolicy.ts?raw';
import posterPolicySource from '../src/lib/ppvPosterPolicy.ts?raw';
import {
  PPV_POSTER_HOSTS,
  inspectPpvPosterUrl,
  isAllowedPpvPosterUrl,
  safePpvPosterUrl,
} from '../src/lib/ppvPosterPolicy';
import {
  PPV_CATALOG_CACHE_KEY,
  aggregatePpvCatalog,
  readPpvCatalogCache,
  writePpvCatalogCache,
} from '../src/lib/ppvCatalogAggregator';
import { loadPpvCatalog, streamedPosterUrl, type PpvCatalog, type PpvEvent } from '../src/lib/ppv';
import { mapSportsDbEvent } from '../src/lib/ppvTheSportsDb';
import type { PpvCatalogProvider } from '../src/lib/ppvProviders';

const TRACKER = 'https://tracker.example/pixel.png';
const SOON = Date.now() + 3_600_000;

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

/* Serves the three Streamed catalog feeds from one fixture list. */
function streamedFetch(rows: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/api/matches/fight') ? json(rows) : json([]),
  ) as unknown as typeof fetch;
}

function imageSources(): string[] {
  return [...document.querySelectorAll('img')].map((node) => node.getAttribute('src') ?? '');
}

/* --- A-D: what the policy accepts ---------------------------------------- */

describe('A-D. poster policy', () => {
  it('A. refuses an arbitrary absolute HTTPS host', () => {
    expect(isAllowedPpvPosterUrl(TRACKER)).toBe(false);
    expect(inspectPpvPosterUrl(TRACKER).reason).toBe('rejected_host');
    expect(isAllowedPpvPosterUrl('https://cdn.evil.example/a.jpg')).toBe(false);
    /* A look-alike host is still not the approved host. */
    expect(isAllowedPpvPosterUrl('https://streamed.pk.evil.example/a.jpg')).toBe(false);
    expect(isAllowedPpvPosterUrl('https://evil.example/streamed.pk/a.jpg')).toBe(false);
  });

  it('B. refuses a URL carrying credentials', () => {
    expect(isAllowedPpvPosterUrl('https://user:pass@example.com/a.jpg')).toBe(false);
    /* Even on the approved host: credentials in a URL are never rendered. */
    expect(isAllowedPpvPosterUrl('https://user:pass@streamed.pk/a.jpg')).toBe(false);
    expect(inspectPpvPosterUrl('https://user:pass@streamed.pk/a.jpg').reason).toBe('credentials');
  });

  it('C. refuses plain HTTP, including on the approved host', () => {
    expect(isAllowedPpvPosterUrl('http://example.com/a.jpg')).toBe(false);
    expect(isAllowedPpvPosterUrl('http://streamed.pk/a.jpg')).toBe(false);
    expect(inspectPpvPosterUrl('http://streamed.pk/a.jpg').reason).toBe('non_https');
  });

  it('D. refuses javascript:, data:, blob:, local hosts and malformed values', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'blob:https://streamed.pk/abc',
      'https://localhost/a.jpg',
      'https://127.0.0.1/a.jpg',
      'https://192.168.1.5/a.jpg',
      'not a url',
      '',
      '   ',
      null,
      undefined,
      42,
      { evil: true },
    ]) {
      expect(isAllowedPpvPosterUrl(value)).toBe(false);
    }
    expect(safePpvPosterUrl(TRACKER)).toBeUndefined();
    expect(safePpvPosterUrl('https://streamed.pk/a.jpg')).toBe('https://streamed.pk/a.jpg');
  });

  it('keeps the approved list to explicitly reviewed hosts', () => {
    expect(PPV_POSTER_HOSTS).toEqual(['streamed.pk']);
    for (const host of PPV_POSTER_HOSTS) expect(host).not.toContain('*');
    /* Never a rule of the form "any https is fine". */
    expect(posterPolicySource).not.toMatch(/return\s+value\.startsWith\('https:\/\/'\)/);
  });

  it('never records a refused destination beyond its hostname', () => {
    const inspection = inspectPpvPosterUrl('https://tracker.example/pixel.png?uid=SECRET');
    expect(inspection.hostname).toBe('tracker.example');
    expect(JSON.stringify(inspection)).not.toContain('SECRET');
    expect(JSON.stringify(inspection)).not.toContain('pixel.png');
  });
});

/* --- catalog mapping ----------------------------------------------------- */

describe('catalog mapping drops a refused poster and keeps the event', () => {
  it('A. admits the event and refuses the tracker poster', async () => {
    const catalog = await loadPpvCatalog(
      streamedFetch([
        { id: 'ufc-400', title: 'UFC 400', category: 'fight', date: SOON, poster: TRACKER },
      ]),
    );
    expect(catalog.events).toHaveLength(1);
    expect(catalog.events[0].providerEventId).toBe('ufc-400');
    expect(catalog.events[0].poster).toBeUndefined();
    expect(JSON.stringify(catalog.events)).not.toContain('tracker.example');
    expect(catalog.diagnostics?.rejectedPosters).toBe(1);
  });

  it('F. an event with a refused poster keeps everything that matters', async () => {
    const catalog = await loadPpvCatalog(
      streamedFetch([
        {
          id: 'ufc-400',
          title: 'UFC 400: Jones vs Aspinall',
          category: 'fight',
          date: SOON,
          poster: TRACKER,
          teams: { home: { name: 'Jon Jones' }, away: { name: 'Tom Aspinall' } },
          sources: [{ source: 'delta', id: 'ufc-400-d' }],
        },
      ]),
    );
    const [entry] = catalog.events;
    expect(entry.title).toBe('UFC 400: Jones vs Aspinall');
    expect(entry.category).toBe('mma');
    expect(entry.promotion).toBe('UFC');
    expect(entry.status).toBe('upcoming');
    expect(entry.participants).toEqual(['Jon Jones', 'Tom Aspinall']);
    expect(entry.sourceRefs).toEqual([{ source: 'delta', id: 'ufc-400-d' }]);
    expect(entry.providerRefs?.streamed?.eventId).toBe('ufc-400');
    expect(entry.catalogProvenance?.feeds).toEqual(['fight']);
  });

  it('still renders a poster served from the approved origin', () => {
    expect(streamedPosterUrl('/api/images/poster/abc.webp')).toBe(
      'https://streamed.pk/api/images/poster/abc.webp',
    );
    expect(streamedPosterUrl('abc')).toBe('https://streamed.pk/api/images/proxy/abc.webp');
    expect(streamedPosterUrl('https://streamed.pk/api/images/proxy/abc.webp')).toBe(
      'https://streamed.pk/api/images/proxy/abc.webp',
    );
    expect(streamedPosterUrl(TRACKER)).toBeUndefined();
    expect(streamedPosterUrl('')).toBeUndefined();
    /* A protocol-relative path cannot smuggle in another host. */
    expect(streamedPosterUrl('//tracker.example/pixel.png')).toBe(
      'https://streamed.pk//tracker.example/pixel.png',
    );
  });

  it('counts refused posters without recording where they pointed', async () => {
    const catalog = await loadPpvCatalog(
      streamedFetch([
        { id: 'a', title: 'UFC 400', category: 'fight', date: SOON, poster: TRACKER },
        { id: 'b', title: 'UFC 401', category: 'fight', date: SOON, poster: 'https://x.example/1.png' },
        { id: 'c', title: 'UFC 402', category: 'fight', date: SOON, poster: 'abc' },
      ]),
    );
    expect(catalog.diagnostics?.rejectedPosters).toBe(2);
    expect(JSON.stringify(catalog.diagnostics)).not.toContain('example');
  });
});

/* --- E: cache ------------------------------------------------------------ */

describe('E. cached posters are re-validated on read', () => {
  it('keeps the cached event and drops its arbitrary poster', () => {
    const storage = memoryStorage();
    const now = Date.now();
    storage.setItem(
      PPV_CATALOG_CACHE_KEY,
      JSON.stringify({ savedAt: now, events: [{ ...event(), poster: TRACKER }] }),
    );

    const cached = readPpvCatalogCache(now, storage);
    expect(cached?.events).toHaveLength(1);
    expect(cached?.events[0].title).toBe('UFC 400: Jones vs Aspinall');
    expect(cached?.events[0].poster).toBeUndefined();
    expect(JSON.stringify(cached?.events)).not.toContain('tracker.example');
  });

  it('a poster that was previously stored gets no extra trust', () => {
    const storage = memoryStorage();
    const now = Date.now();
    /* Written through the normal path, then tampered with in storage. */
    writePpvCatalogCache([event({ poster: 'https://streamed.pk/a.webp' })], now, storage);
    const raw = JSON.parse(storage.getItem(PPV_CATALOG_CACHE_KEY) as string);
    raw.events[0].poster = 'https://attacker.example/pixel.gif';
    storage.setItem(PPV_CATALOG_CACHE_KEY, JSON.stringify(raw));

    expect(readPpvCatalogCache(now, storage)?.events[0].poster).toBeUndefined();
  });

  it('preserves a legitimate cached poster through a round trip', () => {
    const storage = memoryStorage();
    const now = Date.now();
    writePpvCatalogCache([event({ poster: 'https://streamed.pk/a.webp' })], now, storage);
    expect(readPpvCatalogCache(now, storage)?.events[0].poster).toBe('https://streamed.pk/a.webp');
  });

  it('an aggregate served from cache carries no refused poster', async () => {
    const storage = memoryStorage();
    const now = Date.now();
    storage.setItem(
      PPV_CATALOG_CACHE_KEY,
      JSON.stringify({ savedAt: now - 60_000, events: [{ ...event(), poster: TRACKER }] }),
    );
    const dead: PpvCatalogProvider = {
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

    const catalog = await aggregatePpvCatalog({ providers: [dead], storage, now });
    expect(catalog.events).toHaveLength(1);
    expect(catalog.events[0].poster).toBeUndefined();
  });
});

/* --- rendering ----------------------------------------------------------- */

describe('rendering never requests a refused poster', () => {
  function catalogWith(events: PpvEvent[]): () => Promise<PpvCatalog> {
    return async () => ({ events, source: 'streamed', loadedAt: new Date().toISOString() });
  }

  it('A/G. renders the card with the local fallback and no tracker request', async () => {
    render(<PpvPanel loadCatalog={catalogWith([event({ poster: TRACKER })])} />);
    expect(await screen.findByText('UFC 400: Jones vs Aspinall')).toBeInTheDocument();

    /* Nothing points at the injected host, and no image element exists at all. */
    expect(imageSources().some((src) => src.includes('tracker.example'))).toBe(false);
    expect(document.querySelector('.live-tv-channel__logo img')).toBeNull();
    /* The card still looks intentional: the local icon took its place. */
    expect(document.querySelector('.live-tv-channel__logo svg')).not.toBeNull();
  });

  it('F. the event stays selectable with a refused poster', async () => {
    render(<PpvPanel loadCatalog={catalogWith([event({ poster: TRACKER })])} />);
    const row = await screen.findByRole('button', { name: 'Watch UFC 400: Jones vs Aspinall' });
    fireEvent.click(row);
    expect(await screen.findByLabelText('PPV player')).toBeInTheDocument();
    expect(imageSources().some((src) => src.includes('tracker.example'))).toBe(false);
  });

  it('G. a poster-less event renders a usable row', async () => {
    render(<PpvPanel loadCatalog={catalogWith([event()])} />);
    expect(await screen.findByText('UFC 400: Jones vs Aspinall')).toBeInTheDocument();
    expect(document.querySelector('.live-tv-channel__logo svg')).not.toBeNull();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('renders an approved poster, and falls back to the icon if it fails to load', async () => {
    render(<PpvPanel loadCatalog={catalogWith([event({ poster: 'https://streamed.pk/a.webp' })])} />);
    await screen.findByText('UFC 400: Jones vs Aspinall');
    const image = document.querySelector('.live-tv-channel__logo img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://streamed.pk/a.webp');

    /* A broken image becomes the icon, not an empty square. */
    fireEvent.error(image);
    expect(document.querySelector('.live-tv-channel__logo img')).toBeNull();
    expect(document.querySelector('.live-tv-channel__logo svg')).not.toBeNull();
  });
});

/* --- H-J: nothing else moved -------------------------------------------- */

describe('H-J. surrounding policy is unchanged', () => {
  it('H. TheSportsDB still ignores its image fields', () => {
    const mapped = mapSportsDbEvent({
      idEvent: '1',
      strEvent: 'UFC 400',
      strSport: 'Fighting',
      strLeague: 'Ultimate Fighting Championship',
      strTimestamp: new Date(SOON).toISOString().replace('Z', '').slice(0, 19),
      strThumb: 'https://www.thesportsdb.com/images/x.jpg',
      strPoster: TRACKER,
    } as Record<string, unknown>);
    expect(mapped?.poster).toBeUndefined();
    expect(theSportsDbSource).not.toMatch(/row\??\.\s*strThumb/);
    expect(theSportsDbSource).not.toMatch(/row\??\.\s*strPoster/);
  });

  it('I/J. the embed and iframe policies are untouched by poster handling', () => {
    expect(embedPolicySource).toContain(
      "export const PPV_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-presentation'",
    );
    expect(embedPolicySource).toContain(
      "export const PPV_IFRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'",
    );
    expect(embedPolicySource).toContain(
      "export const PPV_IFRAME_ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture'",
    );
    expect(embedPolicySource).toContain(
      "export const PPV_EMBED_HOSTS: readonly string[] = ['embed.st', 'embed.streamapi.cc']",
    );
    /* The poster policy is its own list and never reaches the embed hosts. */
    expect(PPV_POSTER_HOSTS).not.toContain('embed.st');
    expect(PPV_POSTER_HOSTS).not.toContain('embed.streamapi.cc');
  });

  it('adds no proxy, relay or replacement image service', () => {
    expect(posterPolicySource).not.toMatch(
      /cors-anywhere|allorigins|corsproxy|images\.weserv|wsrv\.nl|proxy\.|serviceWorker|fetch\(/i,
    );
    /* Refusing a poster means not rendering it, not fetching it another way. */
    expect(posterPolicySource).not.toMatch(/XMLHttpRequest|createObjectURL|btoa\(/);
  });
});
