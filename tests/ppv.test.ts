import { describe, expect, it, vi } from 'vitest';
import {
  classifyPpvCategory,
  derivePpvStatus,
  isHostedEmbedUrl,
  loadPpvCatalog,
  mapStreamedMatch,
  mergePpvEmbeds,
} from '../src/lib/ppv';
import { PPV_IFRAME_REFERRER_POLICY, PPV_IFRAME_SANDBOX } from '../src/lib/ppvEmbedPolicy';

const now = Date.parse('2026-08-28T20:00:00.000Z');

describe('PPV iframe policy', () => {
  it('uses a narrow sandbox and a strict referrer policy', () => {
    expect(PPV_IFRAME_SANDBOX).toBe('allow-scripts allow-presentation');
    expect(PPV_IFRAME_REFERRER_POLICY).toBe('no-referrer');
    expect(PPV_IFRAME_SANDBOX).not.toMatch(/allow-popups-to-escape-sandbox/);
    expect(PPV_IFRAME_SANDBOX).not.toMatch(/allow-popups(?!-)/);
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-top-navigation');
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-downloads');
    expect(PPV_IFRAME_SANDBOX).not.toContain('allow-same-origin');
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
