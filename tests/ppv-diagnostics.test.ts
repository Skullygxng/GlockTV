import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PPV_REQUEST_TIMEOUT_MS,
  PpvCatalogError,
  PpvHttpError,
  PpvTimeoutError,
  classifyPpvRequestError,
  discoverPpvEmbeds,
  loadPpvCatalog,
  type PpvEvent,
} from '../src/lib/ppv';
import { inspectPpvEmbedUrl } from '../src/lib/ppvEmbedPolicy';
import { sanitizePpvDiagnostics, serializePpvDiagnostics } from '../src/lib/ppvDiagnostics';

const STREAMED = 'https://streamed.pk';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function httpError(status: number): Response {
  return new Response('nope', { status, headers: { 'Content-Type': 'text/plain' } });
}

const event: PpvEvent = {
  provider: 'streamed',
  providerEventId: 'ufc-320',
  title: 'UFC 320',
  category: 'mma',
  startsAt: '2026-08-29T22:00:00.000Z',
  status: 'live',
  sourceRefs: [{ source: 'delta', id: 'd1' }],
  embeds: [],
};

describe('PPV request error classification', () => {
  it('separates the failure classes instead of collapsing them', () => {
    expect(classifyPpvRequestError(new PpvTimeoutError('x')).status).toBe('timeout');
    expect(classifyPpvRequestError(new PpvHttpError(404))).toEqual({
      status: 'http_error',
      httpStatus: 404,
    });
    expect(classifyPpvRequestError(new SyntaxError('bad json')).status).toBe('malformed');
    // A browser fetch rejection is not proof of CORS specifically.
    expect(classifyPpvRequestError(new TypeError('Failed to fetch')).status).toBe(
      'network_or_cors_error',
    );
  });
});

describe('PPV catalog diagnostics', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const populated = [
    {
      id: 'ufc-320',
      title: 'UFC 320 Smith vs Jones',
      category: 'fight',
      date: Date.now() + 3_600_000,
      sources: [{ source: 'delta', id: 'd1' }],
    },
  ];

  /* Answers fight from `fight`, and every other catalog endpoint from `rest`. */
  function catalogFetch(
    fight: () => Response | Promise<Response>,
    rest: () => Response | Promise<Response> = () => json([]),
  ) {
    return vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/api/matches/fight') ? fight() : rest(),
    ) as unknown as typeof fetch;
  }

  async function rejectedDiagnostics(request: typeof fetch, advanceMs = 0) {
    const pending = loadPpvCatalog(request).then(
      () => null,
      (reason: unknown) => reason,
    );
    if (advanceMs) await vi.advanceTimersByTimeAsync(advanceMs);
    const reason = await pending;
    expect(reason).toBeInstanceOf(PpvCatalogError);
    return (reason as PpvCatalogError).diagnostics;
  }

  it('reports per-endpoint row counts and normalized events on success', async () => {
    const catalog = await loadPpvCatalog(catalogFetch(() => json(populated)));
    expect(catalog.diagnostics?.overallStatus).toBe('success');
    expect(catalog.diagnostics?.fight).toEqual({ status: 'success', httpStatus: null, rowCount: 1 });
    expect(catalog.diagnostics?.live).toEqual({ status: 'empty_success', httpStatus: null, rowCount: 0 });
    expect(catalog.diagnostics?.today).toEqual({ status: 'empty_success', httpStatus: null, rowCount: 0 });
    expect(catalog.diagnostics?.normalizedEvents).toBe(1);
  });

  it('reports empty_success when the fight feed worked but produced nothing', async () => {
    const catalog = await loadPpvCatalog(catalogFetch(() => json([])));
    expect(catalog.diagnostics?.fight.status).toBe('empty_success');
    expect(catalog.diagnostics?.overallStatus).toBe('empty_success');
    expect(catalog.diagnostics?.normalizedEvents).toBe(0);
  });

  it('carries the HTTP status of a failed fight feed out on the rejection', async () => {
    const diagnostics = await rejectedDiagnostics(catalogFetch(() => httpError(500)));
    expect(diagnostics.fight).toEqual({ status: 'http_error', httpStatus: 500, rowCount: 0 });
    expect(diagnostics.overallStatus).toBe('http_error');
    expect(diagnostics.normalizedEvents).toBe(0);
  });

  it('classifies a fetch rejection as network_or_cors_error without asserting CORS', async () => {
    const diagnostics = await rejectedDiagnostics(
      catalogFetch(() => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect(diagnostics.fight.status).toBe('network_or_cors_error');
    expect(diagnostics.fight.httpStatus).toBeNull();
  });

  it('classifies a hung fight feed as a timeout in finite time', async () => {
    const diagnostics = await rejectedDiagnostics(
      catalogFetch(() => new Promise<Response>(() => {})),
      15_000,
    );
    expect(diagnostics.fight.status).toBe('timeout');
  });

  it('classifies invalid JSON on the required feed as malformed', async () => {
    const diagnostics = await rejectedDiagnostics(
      catalogFetch(
        () => new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    expect(diagnostics.fight.status).toBe('malformed');
  });

  it('reports a valid-JSON wrong-shape fight response as malformed without inventing a rejection', async () => {
    // Production already resolved here; only the label is new.
    const catalog = await loadPpvCatalog(catalogFetch(() => json({ nope: true })));
    expect(catalog.events).toEqual([]);
    expect(catalog.diagnostics?.fight).toEqual({ status: 'malformed', httpStatus: null, rowCount: 0 });
    expect(catalog.diagnostics?.overallStatus).toBe('malformed');
  });

  it('separates an optional endpoint that failed from one that was genuinely empty', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/fight')) return json(populated);
      if (url.endsWith('/api/matches/live')) return httpError(502);
      return json([]);
    }) as unknown as typeof fetch;

    const catalog = await loadPpvCatalog(request);
    // Graceful degradation is preserved: the catalog still loads.
    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.live).toEqual({ status: 'http_error', httpStatus: 502, rowCount: 0 });
    expect(catalog.diagnostics?.today.status).toBe('empty_success');
    expect(catalog.diagnostics?.overallStatus).toBe('success');
  });

  it('records rows returned by the optional live feed', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/all-today')) return json([]);
      return json(populated);
    }) as unknown as typeof fetch;

    const catalog = await loadPpvCatalog(request);
    expect(catalog.diagnostics?.live).toEqual({ status: 'success', httpStatus: null, rowCount: 1 });
  });

  it('records a hung optional live feed as a timeout while the catalog still loads', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/live')) return new Promise<Response>(() => {});
      if (url.endsWith('/api/matches/fight')) return json(populated);
      return json([]);
    }) as unknown as typeof fetch;

    const pending = loadPpvCatalog(request);
    await vi.advanceTimersByTimeAsync(15_000);
    const catalog = await pending;
    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.live.status).toBe('timeout');
  });

  it('classifies a failed today feed the same way without blocking the catalog', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/matches/all-today')) {
        throw new TypeError('Failed to fetch');
      }
      if (url.endsWith('/api/matches/fight')) return json(populated);
      return json([]);
    }) as unknown as typeof fetch;

    const catalog = await loadPpvCatalog(request);
    expect(catalog.events).toHaveLength(1);
    expect(catalog.diagnostics?.today.status).toBe('network_or_cors_error');
  });

  it('keeps URLs and provider payloads out of the catalog failure it reports', async () => {
    const diagnostics = await rejectedDiagnostics(catalogFetch(() => httpError(403)));
    const payload = serializePpvDiagnostics(diagnostics);
    expect(payload).not.toContain('https://');
    expect(payload).not.toContain('http://');
    expect(payload).not.toContain('streamed.pk');
    expect(payload).not.toContain('/api/matches');
    expect(payload).toContain('http_error');
  });

  it('reports a generic message so the failing URL never reaches the UI', async () => {
    const reason = await loadPpvCatalog(catalogFetch(() => httpError(500))).then(
      () => null,
      (error: unknown) => error,
    );
    // PpvTimeoutError names the URL it gave up on; that message must not be
    // what the panel ends up rendering.
    expect((reason as Error).message).toBe('PPV events could not load.');
    expect((reason as Error).message).not.toContain('://');
  });
});

describe('PPV Streamed discovery diagnostics', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const twoSources: PpvEvent = {
    ...event,
    sourceRefs: [
      { source: 'alpha', id: 'a1' },
      { source: 'delta', id: 'd1' },
    ],
  };

  it('records an HTTP status per failing source', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) return httpError(404);
      return json({ success: true, data: { sources: [] } });
    });

    const { diagnostics } = await discoverPpvEmbeds(event, request as unknown as typeof fetch);
    expect(diagnostics.streamed.httpErrorCount).toBe(1);
    expect(diagnostics.streamed.httpStatuses).toEqual([404]);
    expect(diagnostics.finalState).toBe('provider_failure');
  });

  it('records a timeout without discarding a source that answered', async () => {
    const request = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/stream/alpha/')) return new Promise<Response>(() => {});
      if (url.includes('/stream/delta/')) {
        return Promise.resolve(json([{ id: 's1', embedUrl: 'https://embed.st/e/1', source: 'delta' }]));
      }
      return Promise.resolve(json({ success: true, data: { sources: [] } }));
    });

    const pending = discoverPpvEmbeds(twoSources, request as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    const { embeds, diagnostics } = await pending;

    expect(embeds).toHaveLength(1);
    expect(diagnostics.streamed.timeoutCount).toBe(1);
    expect(diagnostics.streamed.completedRequests).toBe(1);
    expect(diagnostics.finalState).toBe('playable_candidate');
  });

  it('records a network/CORS failure', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) throw new TypeError('Failed to fetch');
      return json({ success: true, data: { sources: [] } });
    });

    const { diagnostics } = await discoverPpvEmbeds(event, request as unknown as typeof fetch);
    expect(diagnostics.streamed.networkErrorCount).toBe(1);
  });

  it('counts malformed rows separately from policy rejections', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) {
        return json([{ id: 'a' }, { id: 'b', embedUrl: 'https://evil.example/player' }]);
      }
      return json({ success: true, data: { sources: [] } });
    });

    const { diagnostics } = await discoverPpvEmbeds(event, request as unknown as typeof fetch);
    expect(diagnostics.streamed.returnedSourceCount).toBe(2);
    expect(diagnostics.streamed.malformedRowCount).toBe(1);
    expect(diagnostics.streamed.rejectedEmbedCount).toBe(1);
    expect(diagnostics.streamed.rejectedHosts).toEqual(['evil.example']);
    expect(diagnostics.streamed.rejectionReasons).toEqual(['host_not_allowlisted']);
    expect(diagnostics.finalState).toBe('policy_rejected');
  });

  it('separates accepted from rejected in a mixed response', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) {
        return json([
          { id: 'ok', embedUrl: 'https://embed.st/e/1', source: 'delta' },
          { id: 'no', embedUrl: 'https://cdn.example/x.m3u8' },
        ]);
      }
      return json({ success: true, data: { sources: [] } });
    });

    const { embeds, diagnostics } = await discoverPpvEmbeds(event, request as unknown as typeof fetch);
    expect(embeds).toHaveLength(1);
    expect(diagnostics.streamed.acceptedEmbedCount).toBe(1);
    expect(diagnostics.streamed.rejectedEmbedCount).toBe(1);
    expect(diagnostics.streamed.rejectionReasons).toContain('media_playlist');
  });
});

describe('PPV SportSRC discovery diagnostics', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  /* Only an event carrying a SportSRC-native identity reaches SportSRC at all. */
  const mapped: PpvEvent = {
    ...event,
    providerRefs: {
      streamed: { eventId: 'ufc-320' },
      sportsrc: { eventId: 'sportsrc-native-9001', category: 'fight' },
    },
  };

  async function sportsrcRun(responder: (url: string) => Promise<Response>) {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/stream/')) return json([]);
      return responder(url);
    });
    return discoverPpvEmbeds(mapped, request as unknown as typeof fetch);
  }

  it('reports an attempted lookup with the provider-native identity', async () => {
    const { diagnostics } = await sportsrcRun(async () => json({ success: true, data: { sources: [] } }));
    expect(diagnostics.sportsrc.lookupState).toBe('attempted');
    expect(diagnostics.sportsrc.providerNativeIdentityAvailable).toBe(true);
    expect(diagnostics.sportsrc.requestCount).toBe(1);
    expect(diagnostics.sportsrc.requestedCategory).toBe('fight');
  });

  it('does not request SportSRC at all when no native identity exists', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) return json([]);
      throw new Error('SportSRC must not be requested for an unmapped event');
    });

    // The base event carries Streamed identity only.
    const { diagnostics } = await discoverPpvEmbeds(event, request as unknown as typeof fetch);
    expect(diagnostics.sportsrc.lookupState).toBe('not_attempted_unmapped');
    expect(diagnostics.sportsrc.providerNativeIdentityAvailable).toBe(false);
    expect(diagnostics.sportsrc.requestCount).toBe(0);
    // A skipped lookup invents no failure counters.
    expect(diagnostics.sportsrc.httpErrorCount).toBe(0);
    expect(diagnostics.sportsrc.httpStatuses).toEqual([]);
    expect(diagnostics.sportsrc.networkErrorCount).toBe(0);
    expect(diagnostics.sportsrc.timeoutCount).toBe(0);
    expect(diagnostics.sportsrc.malformedResponseCount).toBe(0);
    expect(diagnostics.finalState).toBe('unavailable');
  });

  it('records an HTTP status', async () => {
    const { diagnostics } = await sportsrcRun(async () => httpError(404));
    expect(diagnostics.sportsrc.httpStatuses).toEqual([404]);
  });

  it('records a timeout', async () => {
    const request = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/stream/')) return Promise.resolve(json([]));
      return new Promise<Response>(() => {});
    });
    const pending = discoverPpvEmbeds(mapped, request as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(PPV_REQUEST_TIMEOUT_MS + 50);
    const { diagnostics } = await pending;
    expect(diagnostics.sportsrc.timeoutCount).toBe(1);
  });

  it('records a network/CORS failure', async () => {
    const { diagnostics } = await sportsrcRun(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(diagnostics.sportsrc.networkErrorCount).toBe(1);
  });

  it('treats success:false as an unsuccessful lookup, not a malformed response', async () => {
    const falsy = await sportsrcRun(async () => json({ success: false }));
    expect(falsy.diagnostics.sportsrc.responseSuccessFlag).toBe(false);
    expect(falsy.diagnostics.sportsrc.hasData).toBe(false);
    expect(falsy.diagnostics.sportsrc.hasSources).toBe(false);
    // A well-formed body reporting no result is not a structural contradiction.
    expect(falsy.diagnostics.sportsrc.providerReportedUnsuccessful).toBe(true);
    expect(falsy.diagnostics.sportsrc.malformedResponseCount).toBe(0);
    expect(falsy.diagnostics.finalState).toBe('unavailable');
  });

  it('reserves malformed for a body that contradicts its own success flag', async () => {
    const wrongType = await sportsrcRun(async () =>
      json({ success: true, data: { sources: 'nope' } }),
    );
    expect(wrongType.diagnostics.sportsrc.malformedResponseCount).toBe(1);
    expect(wrongType.diagnostics.sportsrc.providerReportedUnsuccessful).toBeUndefined();

    const notAnObject = await sportsrcRun(async () => json('nope'));
    expect(notAnObject.diagnostics.sportsrc.malformedResponseCount).toBe(1);
  });

  it('distinguishes missing data, missing sources and empty sources', async () => {
    const noSources = await sportsrcRun(async () => json({ success: true, data: {} }));
    expect(noSources.diagnostics.sportsrc.hasData).toBe(true);
    expect(noSources.diagnostics.sportsrc.hasSources).toBe(false);
    expect(noSources.diagnostics.sportsrc.malformedResponseCount).toBe(1);

    const empty = await sportsrcRun(async () => json({ success: true, data: { sources: [] } }));
    expect(empty.diagnostics.sportsrc.hasSources).toBe(true);
    expect(empty.diagnostics.sportsrc.returnedSourceCount).toBe(0);
  });

  it('records a rejected hostname and accepts an approved one', async () => {
    const rejected = await sportsrcRun(async () =>
      json({ success: true, data: { sources: [{ id: 'x', embedUrl: 'https://sketchy.example/p?t=secret' }] } }),
    );
    expect(rejected.diagnostics.sportsrc.rejectedHosts).toEqual(['sketchy.example']);

    const accepted = await sportsrcRun(async () =>
      json({ success: true, data: { sources: [{ id: 'x', embedUrl: 'https://embed.streamapi.cc/s/1' }] } }),
    );
    expect(accepted.embeds).toHaveLength(1);
    expect(accepted.diagnostics.sportsrc.acceptedEmbedCount).toBe(1);
  });
});

describe('PPV embed policy diagnostics', () => {
  it('reports a safe reason and hostname only for every rejection class', () => {
    expect(inspectPpvEmbedUrl('')).toEqual({ allowed: false, reason: 'empty', hostname: '' });
    expect(inspectPpvEmbedUrl('not a url')).toEqual({
      allowed: false,
      reason: 'malformed',
      hostname: '',
    });
    expect(inspectPpvEmbedUrl('http://embed.st/e/1').reason).toBe('non_https');
    expect(inspectPpvEmbedUrl('https://user:pw@embed.st/e/1').reason).toBe('credentials');
    expect(inspectPpvEmbedUrl('https://127.0.0.1/p').reason).toBe('local_or_private');
    // In jsdom the page origin is localhost, so it is caught by the local rule
    // first; own_origin is exercised below against a non-local origin.
    expect(inspectPpvEmbedUrl(`https://${window.location.hostname}/p`).allowed).toBe(false);
    expect(inspectPpvEmbedUrl('https://embed.st/a/index.m3u8').reason).toBe('media_playlist');
    expect(inspectPpvEmbedUrl('https://unknown.example/p').reason).toBe('host_not_allowlisted');
    expect(inspectPpvEmbedUrl('https://embed.st/e/1')).toEqual({
      allowed: true,
      reason: 'allowed',
      hostname: 'embed.st',
    });
  });

  it('refuses to frame GlockTV itself', () => {
    vi.stubGlobal('location', { hostname: 'glocktv.example', search: '' });
    try {
      expect(inspectPpvEmbedUrl('https://glocktv.example/GlockTV/')).toEqual({
        allowed: false,
        reason: 'own_origin',
        hostname: 'glocktv.example',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never retains the path or query of a rejected URL', () => {
    const secret = 'https://sketchy.example/deep/path?token=SUPERSECRET&sig=abc';
    const inspection = inspectPpvEmbedUrl(secret);
    const text = JSON.stringify(inspection);
    expect(inspection.hostname).toBe('sketchy.example');
    expect(text).not.toContain('SUPERSECRET');
    expect(text).not.toContain('token');
    expect(text).not.toContain('/deep/path');
    expect(text).not.toContain('https://');
  });
});

describe('PPV diagnostics sanitizer', () => {
  it('redacts anything URL-like or credential-like but keeps hostnames', () => {
    const dirty = {
      hostname: 'embed.st',
      leaked: 'https://embed.st/path?token=abc',
      cookie: 'session=xyz',
      count: 3,
      nested: { authorization: 'Bearer abc', hosts: ['embed.streamapi.cc'] },
    };
    const clean = sanitizePpvDiagnostics(dirty);
    expect(clean.hostname).toBe('embed.st');
    expect(clean.nested.hosts).toEqual(['embed.streamapi.cc']);
    expect(clean.leaked).toBe('[redacted]');
    expect(clean.cookie).toBe('[redacted]');
    expect(clean.nested.authorization).toBe('[redacted]');
    expect(clean.count).toBe(3);
  });

  it('produces a copy payload with no complete URLs', () => {
    const payload = serializePpvDiagnostics({
      hosts: ['evil.example'],
      leaked: 'https://evil.example/x?token=1',
    });
    expect(payload).not.toContain('https://');
    expect(payload).not.toContain('http://');
    expect(payload).not.toContain('token=');
    expect(payload).toContain('evil.example');
  });
});

/*
 * Contract fixture. This confirms parser shape only. It does not prove current
 * provider availability or playback, and it makes no live provider calls.
 */
describe('PPV provider contract fixtures', () => {
  const streamedStreamRow = {
    id: 'delta-1',
    streamNo: 1,
    language: 'English',
    hd: true,
    embedUrl: 'https://embed.st/embed/delta/fixture/1',
    source: 'delta',
  };

  const sportsrcDetail = {
    success: true,
    data: {
      sources: [
        {
          id: 'srcs-1',
          language: 'English',
          hd: false,
          embedUrl: 'https://embed.streamapi.cc/sport/fixture/',
          source: 'echo',
        },
      ],
    },
  };

  it('parses both documented response shapes into approved embeds', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${STREAMED}/api/stream/`)) return json([streamedStreamRow]);
      return json(sportsrcDetail);
    });

    // Both providers only run for an event that carries both identities.
    const bothMapped: PpvEvent = {
      ...event,
      providerRefs: {
        streamed: { eventId: event.providerEventId },
        sportsrc: { eventId: 'sportsrc-native-fixture', category: 'fight' },
      },
    };

    const { embeds, diagnostics } = await discoverPpvEmbeds(
      bothMapped,
      request as unknown as typeof fetch,
    );
    expect(embeds.map((embed) => embed.provider).sort()).toEqual(['sportsrc', 'streamed']);
    expect(diagnostics.streamed.acceptedEmbedCount).toBe(1);
    expect(diagnostics.sportsrc.acceptedEmbedCount).toBe(1);
    expect(diagnostics.finalState).toBe('playable_candidate');
  });
});
