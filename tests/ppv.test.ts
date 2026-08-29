import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PPV_REQUEST_TIMEOUT_MS,
  classifyPpvCategory,
  derivePpvStatus,
  isHostedEmbedUrl,
  loadPpvCatalog,
  loadPpvEmbeds,
  mapStreamedMatch,
  mergePpvEmbeds,
  mergeStreamedMatches,
  type PpvEvent,
} from '../src/lib/ppv';
import { PPV_IFRAME_REFERRER_POLICY, PPV_IFRAME_SANDBOX } from '../src/lib/ppvEmbedPolicy';

const now = Date.parse('2026-08-28T20:00:00.000Z');

describe('PPV iframe policy', () => {
  it('uses a narrow sandbox and a strict referrer policy', () => {
    // Matches the working movie/TV hosted players so embeds can initialise on
    // their own origin. Safe only because the host allowlist can never resolve
    // to GlockTV's own origin.
    expect(PPV_IFRAME_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms allow-presentation');
    expect(PPV_IFRAME_REFERRER_POLICY).toBe('strict-origin-when-cross-origin');
    expect(PPV_IFRAME_SANDBOX).not.toMatch(/allow-popups-to-escape-sandbox/);
    expect(PPV_IFRAME_SANDBOX).not.toMatch(/allow-popups(?!-)/);
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-top-navigation');
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-downloads');
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-modals');
  });
});

describe('PPV normalization', () => {
  it('maps a valid Streamed fight event', () => {
    const event = mapStreamedMatch(
      {
        id: 'ufc-fight-night-286',
        title: 'UFC Fight Night 286 Nurmagomedov vs Song',
        date: Date.parse('2026-08-29T07:00:00.000Z'),
        poster: '/api/images/proxy/abc.webp',
        teams: { home: { name: 'Nurmagomedov' }, away: { name: 'Song' } },
        sources: [{ source: 'delta', id: 'ufc-live' }],
      },
      undefined,
      now,
    );
    expect(event).toMatchObject({
      provider: 'streamed',
      providerEventId: 'ufc-fight-night-286',
      title: 'UFC Fight Night 286 Nurmagomedov vs Song',
      category: 'mma',
      promotion: 'UFC',
      participants: ['Nurmagomedov', 'Song'],
      startsAt: '2026-08-29T07:00:00.000Z',
      status: 'upcoming',
    });
  });

  it('filters stale events and ignores malformed rows', () => {
    expect(
      mapStreamedMatch(
        {
          id: 'old-fight',
          title: 'LFC 63',
          date: Date.parse('2016-12-02T04:00:00.000Z'),
          sources: [],
        },
        undefined,
        now,
      ),
    ).toBeNull();
    expect(mapStreamedMatch({ title: 'No ID', date: now }, undefined, now)).toBeNull();
    expect(mapStreamedMatch({ id: 'no-title', date: now }, undefined, now)).toBeNull();
    expect(mapStreamedMatch({ id: 'no-date', title: 'Missing date' }, undefined, now)).toBeNull();
  });

  it('derives live and upcoming status', () => {
    expect(derivePpvStatus(now + 60 * 60 * 1000, now)).toBe('upcoming');
    expect(derivePpvStatus(now - 10 * 60 * 1000, now)).toBe('live');
    expect(derivePpvStatus(now + 10 * 60 * 1000, now)).toBe('live');
    expect(derivePpvStatus(now - 5 * 60 * 60 * 1000, now)).toBe('ended');
    expect(derivePpvStatus(now - 5 * 60 * 60 * 1000, now, new Set(['live-id']), 'live-id')).toBe('live');
  });

  it('classifies boxing, MMA, and wrestling', () => {
    expect(classifyPpvCategory('Brotherly Love Boxing: Price vs Guevara')).toBe('boxing');
    expect(classifyPpvCategory('UFC Fight Night 286 Nurmagomedov vs Song')).toBe('mma');
    expect(classifyPpvCategory('WWE Friday Night Smackdown')).toBe('wrestling');
  });

  it('removes duplicate embeds', () => {
    const merged = mergePpvEmbeds([
      { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' },
      { provider: 'sportsrc', source: 'delta', url: 'https://embed.st/embed/delta/a/1/' },
      { provider: 'streamed', source: 'admin', url: 'https://embed.st/embed/admin/a/1' },
    ]);
    expect(merged.map((item) => item.url)).toEqual([
      'https://embed.st/embed/delta/a/1',
      'https://embed.st/embed/admin/a/1',
    ]);
  });
});

describe('PPV playback URL safety', () => {
  it('accepts HTTPS hosted embeds and rejects unsafe URLs', () => {
    expect(isHostedEmbedUrl('https://embed.st/embed/delta/event/1')).toBe(true);
    expect(isHostedEmbedUrl('http://embed.st/embed/delta/event/1')).toBe(false);
    expect(isHostedEmbedUrl('https://cdn.example/high/index.m3u8')).toBe(false);
    expect(isHostedEmbedUrl('https://cdn.example/play?file=index.m3u8')).toBe(false);
    expect(isHostedEmbedUrl('not-a-url')).toBe(false);
    expect(isHostedEmbedUrl('')).toBe(false);
  });
});

describe('PPV catalog fetch', () => {
  it('loads fight events from Streamed-shaped JSON and ignores non-combat today rows', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/fight')) {
        return json([
          {
            id: 'ufc-fight-night-286',
            title: 'UFC Fight Night 286 Nurmagomedov vs Song',
            category: 'fight',
            date: Date.parse('2026-08-29T07:00:00.000Z'),
            sources: [{ source: 'delta', id: 'ufc-live' }],
          },
        ]);
      }
      if (url.endsWith('/api/matches/live')) {
        return json([
          {
            id: 'marksman-live',
            title: 'Corey Marksman vs Christian Barreto',
            category: 'fight',
            date: Date.parse('2026-08-28T21:00:00.000Z'),
            sources: [{ source: 'echo', id: 'box-live' }],
          },
        ]);
      }
      if (url.endsWith('/api/matches/all-today')) {
        return json([
          { id: 'nba-game', title: 'Celtics vs Heat', category: 'basketball', date: now },
          {
            id: 'ppv-wwe-friday-night-smackdown',
            title: 'WWE Friday Night Smackdown',
            category: 'fight',
            date: Date.parse('2026-08-29T00:00:00.000Z'),
            sources: [{ source: 'delta', id: 'wwe' }],
          },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    });

    const catalog = await loadPpvCatalog(request as unknown as typeof fetch);
    expect(catalog.source).toBe('streamed');
    expect(catalog.events.map((event) => event.providerEventId)).toEqual([
      'marksman-live',
      'ppv-wwe-friday-night-smackdown',
      'ufc-fight-night-286',
    ]);
    expect(catalog.events.some((event) => event.providerEventId === 'nba-game')).toBe(false);
  });
});

describe('PPV embed URL policy', () => {
  it('allows only the known provider embed hosts', () => {
    expect(isHostedEmbedUrl('https://embed.st/embed/delta/event/1')).toBe(true);
    expect(isHostedEmbedUrl('https://embed.streamapi.cc/sport/backup/')).toBe(true);
    // An arbitrary HTTPS host from a hostile provider response must not frame.
    expect(isHostedEmbedUrl('https://evil.example/player')).toBe(false);
    expect(isHostedEmbedUrl('https://embed.st.evil.example/player')).toBe(false);
  });

  it('never frames GlockTV itself', () => {
    // allow-same-origin plus a same-origin document would be a real escape.
    expect(isHostedEmbedUrl(`https://${window.location.hostname}/player`)).toBe(false);
    expect(isHostedEmbedUrl('https://skullygxng.github.io/GlockTV/')).toBe(false);
  });

  it('rejects local and private destinations', () => {
    expect(isHostedEmbedUrl('https://localhost/player')).toBe(false);
    expect(isHostedEmbedUrl('https://127.0.0.1/player')).toBe(false);
    expect(isHostedEmbedUrl('https://10.0.0.5/player')).toBe(false);
    expect(isHostedEmbedUrl('https://192.168.1.10/player')).toBe(false);
    expect(isHostedEmbedUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isHostedEmbedUrl('https://box.local/player')).toBe(false);
  });

  it('rejects non-https schemes, credentials and malformed URLs', () => {
    expect(isHostedEmbedUrl('http://embed.st/embed/delta/event/1')).toBe(false);
    expect(isHostedEmbedUrl('javascript:alert(1)')).toBe(false);
    expect(isHostedEmbedUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHostedEmbedUrl('blob:https://embed.st/abc')).toBe(false);
    expect(isHostedEmbedUrl('https://user:pass@embed.st/embed/x')).toBe(false);
    expect(isHostedEmbedUrl('not a url')).toBe(false);
    expect(isHostedEmbedUrl('')).toBe(false);
  });

  it('rejects direct media playlists in every observed shape', () => {
    expect(isHostedEmbedUrl('https://embed.st/high/index.m3u8')).toBe(false);
    expect(isHostedEmbedUrl('https://embed.st/high/index.m3u8/')).toBe(false);
    expect(isHostedEmbedUrl('https://embed.st/play?file=index.m3u8')).toBe(false);
    expect(isHostedEmbedUrl('https://embed.st/play?file=index%2Em3u8')).toBe(false);
    expect(isHostedEmbedUrl('https://embed.st/stream.mpd')).toBe(false);
  });
});

describe('PPV catalog merge', () => {
  it('keeps richer metadata when a sparse duplicate arrives later', () => {
    const rich = {
      id: 'ufc-320',
      title: 'UFC Fight Night: Smith vs Jones',
      category: 'fight',
      date: 1_800_000_000_000,
      poster: '/poster.webp',
      teams: { home: { name: 'Smith' }, away: { name: 'Jones' } },
      sources: [{ source: 'alpha', id: 'a1' }],
    };
    const sparse = { id: 'ufc-320', title: 'UFC 320', sources: [{ source: 'delta', id: 'd1' }] };

    const merged = mergeStreamedMatches(rich, sparse);
    expect(merged.title).toBe('UFC Fight Night: Smith vs Jones');
    expect(merged.date).toBe(1_800_000_000_000);
    expect(merged.poster).toBe('/poster.webp');
    expect(merged.teams?.home?.name).toBe('Smith');
    // Source refs are unioned rather than replaced.
    expect(merged.sources).toEqual([
      { source: 'alpha', id: 'a1' },
      { source: 'delta', id: 'd1' },
    ]);
  });
});

describe('PPV request timeouts and failover', () => {
  const event: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'ufc-320',
    title: 'UFC 320',
    category: 'mma',
    startsAt: '2026-08-28T22:00:00.000Z',
    status: 'live',
    sourceRefs: [
      { source: 'alpha', id: 'a1' },
      { source: 'delta', id: 'd1' },
    ],
    embeds: [],
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const never = () => new Promise<Response>(() => {});

  it('keeps a working source when another source hangs forever', async () => {
    const request = vi.fn((url: string) => {
      if (url.includes('/stream/alpha/')) return never();
      if (url.includes('/stream/delta/')) {
        return Promise.resolve(json([{ id: 's1', embedUrl: 'https://embed.st/embed/delta/a/1', source: 'delta' }]));
      }
      return Promise.resolve(json({}));
    });

    const pending = loadPpvEmbeds(event, request as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    const embeds = await pending;
    expect(embeds.map((embed) => embed.url)).toEqual(['https://embed.st/embed/delta/a/1']);
  });

  it('lets the backup provider answer when the primary hangs', async () => {
    const request = vi.fn((url: string) => {
      if (url.includes('streamed.pk')) return never();
      if (url.includes('sportsrc')) {
        return Promise.resolve(
          json({ success: true, data: { sources: [{ id: 'b1', embedUrl: 'https://embed.streamapi.cc/sport/b/' }] } }),
        );
      }
      return Promise.resolve(json({}));
    });

    const pending = loadPpvEmbeds(event, request as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    expect((await pending).map((embed) => embed.url)).toEqual(['https://embed.streamapi.cc/sport/b/']);
  });

  it('reaches an unavailable state after a single provider window when everything hangs', async () => {
    const request = vi.fn((_url: string) => never());
    const pending = loadPpvEmbeds(event, request as unknown as typeof fetch);
    // Primary and backup run together, so one window is the whole budget.
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    expect(await pending).toEqual([]);
    expect(request.mock.calls.every(([url]) => !String(url).includes('daddylive.app'))).toBe(true);
  });

  it('returns empty without requesting an unsupported provider when both are empty', async () => {
    const request = vi.fn((url: string) => {
      if (url.includes('/stream/')) return Promise.resolve(json([]));
      if (url.includes('sportsrc')) return Promise.resolve(json({ success: true, data: { sources: [] } }));
      return Promise.resolve(json({}));
    });

    expect(await loadPpvEmbeds(event, request as unknown as typeof fetch)).toEqual([]);
    // DaddyLive has no approved embed origin, so it must never be requested.
    expect(request.mock.calls.some(([url]) => String(url).includes('daddylive.app'))).toBe(false);
  });

  it('returns the backup result when the primary fails outright', async () => {
    const request = vi.fn((url: string) => {
      if (url.includes('/stream/')) return Promise.reject(new Error('streamed down'));
      if (url.includes('sportsrc')) {
        return Promise.resolve(
          json({ success: true, data: { sources: [{ id: 'b1', embedUrl: 'https://embed.streamapi.cc/sport/b/' }] } }),
        );
      }
      return Promise.resolve(json({}));
    });

    expect((await loadPpvEmbeds(event, request as unknown as typeof fetch)).map((e) => e.url)).toEqual([
      'https://embed.streamapi.cc/sport/b/',
    ]);
    expect(request.mock.calls.some(([url]) => String(url).includes('daddylive.app'))).toBe(false);
  });

  it('aborts the request it timed out', async () => {
    const signals: AbortSignal[] = [];
    const request = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return never();
    });

    const pending = loadPpvEmbeds(event, request as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    await pending;
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it('fails the catalog in finite time rather than loading forever', async () => {
    const pending = loadPpvCatalog(vi.fn(never) as unknown as typeof fetch);
    const assertion = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
