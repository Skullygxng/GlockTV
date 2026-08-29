import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import playerSource from '../src/components/PpvPlayer.tsx?raw';
import { serializePpvDiagnostics } from '../src/lib/ppvDiagnostics';
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

describe('PPV catalog provenance', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  async function provenanceOf(
    feeds: { fight?: Row[]; live?: Row[]; today?: Row[] },
    id = 'ufc-320',
  ) {
    const catalog = await loadPpvCatalog(catalogFetch(feeds));
    return catalog.events.find((event) => event.providerEventId === id)?.catalogProvenance;
  }

  it('records a fight-only event as coming from the fight feed', async () => {
    expect(await provenanceOf({ fight: [row('ufc-320', 'UFC 320')] })).toEqual({
      feeds: ['fight'],
      upstreamCategories: ['fight'],
    });
  });

  it('records a live-only event as coming from the live feed', async () => {
    expect(await provenanceOf({ live: [row('ufc-320', 'UFC 320')] })).toEqual({
      feeds: ['live'],
      upstreamCategories: ['fight'],
    });
  });

  it('records a today-only event as coming from the today feed', async () => {
    expect(await provenanceOf({ today: [row('ufc-320', 'UFC 320')] })).toEqual({
      feeds: ['today'],
      upstreamCategories: ['fight'],
    });
  });

  it('keeps both feeds when the same event arrives on fight and live', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320')],
      live: [row('ufc-320', 'UFC 320 Smith vs Jones')],
    });
    expect(trail?.feeds).toEqual(['fight', 'live']);
  });

  it('keeps both feeds when the same event arrives on fight and today', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320')],
      today: [row('ufc-320', 'UFC 320 Smith vs Jones')],
    });
    expect(trail?.feeds).toEqual(['fight', 'today']);
  });

  it('keeps all three feeds in deterministic order, without duplicates', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320')],
      live: [row('ufc-320', 'UFC 320')],
      today: [row('ufc-320', 'UFC 320'), row('ufc-320', 'UFC 320')],
    });
    // Merging must not let a later feed erase an earlier contributor.
    expect(trail?.feeds).toEqual(['fight', 'live', 'today']);
    expect(trail?.upstreamCategories).toEqual(['fight']);
  });

  it('collects distinct upstream category labels without repeating them', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320', 'fight')],
      live: [row('ufc-320', 'UFC 320', 'mma')],
      today: [row('ufc-320', 'UFC 320', 'mma')],
    });
    expect(trail?.upstreamCategories).toEqual(['fight', 'mma']);
  });

  it('drops an upstream category that is not a plain label', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320 fight card', 'https://evil.example/x?token=SECRET')],
    });
    expect(trail?.feeds).toEqual(['fight']);
    expect(trail?.upstreamCategories).toEqual([]);
  });

  it('serializes provenance with no URLs or secrets', async () => {
    const trail = await provenanceOf({
      fight: [row('ufc-320', 'UFC 320 fight card', 'https://evil.example/x?token=SECRET')],
    });
    const payload = serializePpvDiagnostics({ catalogProvenance: trail });
    expect(payload).not.toContain('https://');
    expect(payload).not.toContain('token=');
    expect(payload).not.toContain('SECRET');
    expect(payload).toContain('fight');
  });

  it('records provenance without altering which events are admitted', async () => {
    /*
     * Synthetic fixtures for the admission rule as it ships today. They
     * describe the rule, not the provenance of any real production event: the
     * feed that introduced the observed college-football event is exactly what
     * these diagnostics exist to find out.
     */
    const catalog = await loadPpvCatalog(
      catalogFetch({
        today: [
          // Admitted today because its upstream category says 'fight'.
          row('synthetic-mislabelled', 'Synthetic Unrelated Matchup', 'fight'),
          // Not admitted: no combat signal from any of the three rules.
          row('synthetic-basketball', 'Synthetic Hoops Matchup', 'basketball'),
        ],
      }),
    );

    const ids = catalog.events.map((event) => event.providerEventId);
    expect(ids).toContain('synthetic-mislabelled');
    expect(ids).not.toContain('synthetic-basketball');
    expect(
      catalog.events.find((event) => event.providerEventId === 'synthetic-mislabelled')
        ?.catalogProvenance,
    ).toEqual({ feeds: ['today'], upstreamCategories: ['fight'] });
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
