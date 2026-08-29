import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import playerSource from '../src/components/PpvPlayer.tsx?raw';
import {
  discoverPpvEmbeds,
  loadPpvCatalog,
  mergePpvEmbeds,
  type PpvEmbed,
  type PpvEvent,
} from '../src/lib/ppv';

const STREAMED = 'https://streamed.pk';
const SOON = Date.now() + 3_600_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Row {
  id: string;
  title: string;
  category?: string;
  date?: number;
  sources?: { source: string; id: string }[];
}

function row(id: string, title: string, category = 'fight'): Row {
  return { id, title, category, date: SOON, sources: [{ source: 'delta', id: `${id}-d` }] };
}

/* Serves the three catalog endpoints from explicit per-feed fixtures. */
function catalogFetch(feeds: { fight?: Row[]; live?: Row[]; today?: Row[] }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/matches/fight')) return json(feeds.fight ?? []);
    if (url.endsWith('/api/matches/live')) return json(feeds.live ?? []);
    if (url.endsWith('/api/matches/all-today')) return json(feeds.today ?? []);
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

async function idsFrom(feeds: { fight?: Row[]; live?: Row[]; today?: Row[] }) {
  const catalog = await loadPpvCatalog(catalogFetch(feeds));
  return catalog.events.map((event) => event.providerEventId);
}

describe('PPV catalog admission', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('treats the fight feed as authoritative, even for a title our classifier reads as other', async () => {
    const ids = await idsFrom({ fight: [row('duel-arena', 'Duel Arena Showcase')] });
    expect(ids).toEqual(['duel-arena']);
  });

  it('excludes a supplemental-only event whose upstream category wrongly says fight', async () => {
    // The real case: a college football game arrived on all-today as 'fight'.
    const ids = await idsFrom({
      today: [row('sjsu-usc', 'San Jose State Spartans at USC Trojans')],
    });
    expect(ids).toEqual([]);
  });

  it('excludes ordinary sports from the supplemental feeds', async () => {
    const ids = await idsFrom({
      live: [row('nfl-game', 'Packers at Bears'), row('nba-game', 'Celtics vs Heat')],
      today: [row('mlb-game', 'Yankees at Red Sox', 'baseball')],
    });
    expect(ids).toEqual([]);
  });

  it('admits supplemental-only combat events our own classifier identifies', async () => {
    const ids = await idsFrom({
      live: [row('true-grit', 'True Grit Wrestling New Grit Rising')],
      today: [row('ufc-320', 'UFC 320 Smith vs Jones'), row('box-1', 'Boxing Night Main Event')],
    });
    expect(ids.sort()).toEqual(['box-1', 'true-grit', 'ufc-320']);
  });

  it('merges the same event from fight and live into one entry', async () => {
    const ids = await idsFrom({
      fight: [row('ufc-320', 'UFC 320')],
      live: [row('ufc-320', 'UFC 320 Smith vs Jones')],
    });
    expect(ids).toEqual(['ufc-320']);
  });

  it('lets a supplemental feed enrich a fight-feed event rather than duplicating it', async () => {
    const catalog = await loadPpvCatalog(
      catalogFetch({
        fight: [{ id: 'ufc-320', title: 'UFC 320', date: SOON, sources: [{ source: 'delta', id: 'd1' }] }],
        today: [
          {
            id: 'ufc-320',
            title: 'UFC 320 Smith vs Jones',
            date: SOON,
            sources: [{ source: 'admin', id: 'a1' }],
          },
        ],
      }),
    );

    expect(catalog.events).toHaveLength(1);
    const [event] = catalog.events;
    // Richer title and the extra source ref both survive the merge.
    expect(event.title).toBe('UFC 320 Smith vs Jones');
    expect(event.sourceRefs.map((ref) => ref.source)).toEqual(['delta', 'admin']);
  });

  it('gives every catalog event a Streamed-native identity and no foreign one', async () => {
    const catalog = await loadPpvCatalog(catalogFetch({ fight: [row('ufc-320', 'UFC 320')] }));
    expect(catalog.events[0].providerRefs?.streamed?.eventId).toBe('ufc-320');
    expect(catalog.events[0].providerRefs?.sportsrc).toBeUndefined();
  });
});

describe('PPV source ordering', () => {
  const embed = (source: string, url: string): PpvEmbed => ({ provider: 'streamed', source, url });

  it('preserves provider order and applies no source-name ranking', () => {
    const ordered = mergePpvEmbeds([
      embed('admin', 'https://embed.st/embed/admin/1'),
      embed('delta', 'https://embed.st/embed/delta/1'),
      embed('golf', 'https://embed.st/embed/golf/1'),
    ]);
    expect(ordered.map((item) => item.source)).toEqual(['admin', 'delta', 'golf']);
  });

  it('keeps the first occurrence of a duplicate URL without reordering the rest', () => {
    const ordered = mergePpvEmbeds([
      embed('admin', 'https://embed.st/embed/shared/a'),
      embed('delta', 'https://embed.st/embed/shared/a'),
      embed('golf', 'https://embed.st/embed/other/b'),
    ]);
    expect(ordered.map((item) => item.source)).toEqual(['admin', 'golf']);
    expect(ordered.map((item) => item.url)).toEqual([
      'https://embed.st/embed/shared/a',
      'https://embed.st/embed/other/b',
    ]);
  });

  it('does not promote any particular source name to the front', () => {
    const ordered = mergePpvEmbeds([
      embed('golf', 'https://embed.st/embed/golf/1'),
      embed('admin', 'https://embed.st/embed/admin/1'),
    ]);
    expect(ordered[0].source).toBe('golf');
  });
});

describe('PPV provider identity network contract', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const streamedOnly: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'streamed-native-777',
    providerRefs: { streamed: { eventId: 'streamed-native-777' } },
    title: 'True Grit Wrestling New Grit Rising',
    category: 'wrestling',
    startsAt: new Date(SOON).toISOString(),
    status: 'live',
    sourceRefs: [{ source: 'delta', id: 'd1' }],
    embeds: [],
  };

  it('requests Streamed but never SportSRC when only a Streamed identity exists', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL) => json([]));
    await discoverPpvEmbeds(streamedOnly, request as unknown as typeof fetch);

    const urls = request.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.startsWith(`${STREAMED}/api/stream/`))).toBe(true);
    expect(urls.some((url) => url.includes('api.sportsrc.org'))).toBe(false);
    // The Streamed identifier must never leak into a SportSRC request.
    expect(urls.some((url) => url.includes('sportsrc') && url.includes('streamed-native-777'))).toBe(
      false,
    );
  });

  it('uses the SportSRC-native identifier, not the Streamed one, when a mapping exists', async () => {
    const mapped: PpvEvent = {
      ...streamedOnly,
      providerRefs: {
        streamed: { eventId: 'streamed-native-777' },
        sportsrc: { eventId: 'sportsrc-native-42', category: 'fight' },
      },
    };

    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/stream/')) return json([]);
      return json({ success: true, data: { sources: [] } });
    });
    await discoverPpvEmbeds(mapped, request as unknown as typeof fetch);

    const sportsrcUrls = request.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('api.sportsrc.org'));
    expect(sportsrcUrls).toHaveLength(1);
    expect(sportsrcUrls[0]).toContain('id=sportsrc-native-42');
    expect(sportsrcUrls[0]).not.toContain('streamed-native-777');
  });
});

describe('PPV real-device regression shapes', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const base: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'case-event',
    providerRefs: { streamed: { eventId: 'case-event' } },
    title: 'Case Event',
    category: 'mma',
    startsAt: new Date(SOON).toISOString(),
    status: 'live',
    sourceRefs: [{ source: 'admin', id: 'a1' }],
    embeds: [],
  };

  /* Case A: the known-good control - two approved Streamed embeds, no backup. */
  it('keeps two approved Streamed embeds in provider order with no SportSRC call', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/api/stream/')) throw new Error('unexpected provider request');
      return json([
        { id: 's1', embedUrl: 'https://embed.st/embed/admin/case/1', source: 'admin' },
        { id: 's2', embedUrl: 'https://embed.st/embed/admin/case/2', source: 'admin' },
      ]);
    });

    const { embeds, diagnostics } = await discoverPpvEmbeds(base, request as unknown as typeof fetch);
    expect(embeds.map((embed) => embed.url)).toEqual([
      'https://embed.st/embed/admin/case/1',
      'https://embed.st/embed/admin/case/2',
    ]);
    expect(diagnostics.acceptedEmbedCount).toBe(2);
    expect(diagnostics.finalState).toBe('playable_candidate');
    expect(diagnostics.sportsrc.requestCount).toBe(0);
    expect(diagnostics.sportsrc.lookupState).toBe('not_attempted_unmapped');
  });

  /* Case B: Streamed answers with nothing and there is no backup to ask. */
  it('reports an empty Streamed answer as unavailable, not a provider failure', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/api/stream/')) throw new Error('unexpected provider request');
      return json([]);
    });

    const { embeds, diagnostics } = await discoverPpvEmbeds(
      { ...base, title: 'True Grit Wrestling New Grit Rising', category: 'wrestling' },
      request as unknown as typeof fetch,
    );
    expect(embeds).toEqual([]);
    expect(diagnostics.streamed.completedRequests).toBe(1);
    expect(diagnostics.streamed.returnedSourceCount).toBe(0);
    expect(diagnostics.sportsrc.requestCount).toBe(0);
    expect(diagnostics.finalState).toBe('unavailable');
  });

  /* Case C: several approved sources, all retained in deterministic order. */
  it('retains every approved Streamed source in stable provider order', async () => {
    const multi: PpvEvent = {
      ...base,
      sourceRefs: [
        { source: 'admin', id: 'a1' },
        { source: 'golf', id: 'g1' },
      ],
    };
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/stream/admin/')) {
        return json([{ id: 'a', embedUrl: 'https://embed.st/embed/admin/duel/1', source: 'admin' }]);
      }
      if (url.includes('/api/stream/golf/')) {
        return json([{ id: 'g', embedUrl: 'https://embed.st/embed/golf/duel/1', source: 'golf' }]);
      }
      throw new Error('unexpected provider request');
    });

    const { embeds } = await discoverPpvEmbeds(multi, request as unknown as typeof fetch);
    expect(embeds.map((embed) => embed.url)).toEqual([
      'https://embed.st/embed/admin/duel/1',
      'https://embed.st/embed/golf/duel/1',
    ]);
  });

  /*
   * A remote player refusing to run inside our sandbox is that player's
   * behaviour, and the control case proves the sandbox itself can host an
   * approved embed. GlockTV must not retry unsandboxed or relax the policy.
   */
  it('never relaxes the iframe policy in response to a player error', async () => {
    expect(playerSource).toContain('sandbox={PPV_IFRAME_SANDBOX}');
    expect(playerSource).not.toMatch(/sandbox=\{(?!PPV_IFRAME_SANDBOX)/);
    expect(playerSource).not.toMatch(/allow-popups|allow-top-navigation|allow-downloads/);
    // No error-text-driven retry, and no unsandboxed fallback frame.
    expect(playerSource).not.toMatch(/SANDBOX IFRAME NOT ALLOWED/i);
    expect(playerSource.match(/<iframe/g) ?? []).toHaveLength(1);
  });
});
