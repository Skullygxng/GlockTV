import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import { PpvPlayer } from '../src/components/PpvPlayer';
import type { PpvEvent } from '../src/lib/ppv';
import { isHostedEmbedUrl } from '../src/lib/ppv';
import {
  PPV_AUTHORIZED_EMBED_HOSTS,
  PPV_TWITCH_PARENT_HOSTS,
  currentTwitchParent,
  isAllowedAuthorizedEmbedUrl,
  twitchChannelFrom,
  twitchEmbedUrl,
  youtubeEmbedUrl,
  youtubeVideoIdFrom,
} from '../src/lib/ppvAuthorizedEmbeds';
import { PPV_EMBED_HOSTS, isAllowedPpvEmbedUrl } from '../src/lib/ppvEmbedPolicy';
import {
  PPV_OFFICIAL_HOSTS,
  PPV_OFFICIAL_INFO_BY_PROMOTION,
  inspectOfficialUrl,
  isAllowedOfficialUrl,
  officialInfoUrlFor,
  officialWatchUrlFor,
} from '../src/lib/ppvOfficialWatch';
import {
  PPV_PLAYBACK_PROVIDERS,
  resolvePpvPlayback,
  sportsrcPlaybackProvider,
  streamedPlaybackProvider,
  twitchPlaybackProvider,
  youtubePlaybackProvider,
} from '../src/lib/ppvPlaybackRegistry';
import { PPV_SOURCE_LOAD_DEADLINE_MS } from '../src/lib/ppvDiagnostics';

const SOON = new Date(Date.now() + 3_600_000).toISOString();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function event(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'thesportsdb',
    providerEventId: 'thesportsdb:2000001',
    title: 'UFC 400: Jones vs Aspinall',
    category: 'mma',
    startsAt: SOON,
    status: 'upcoming',
    sourceRefs: [],
    embeds: [],
    ...overrides,
  };
}

const failingFetch = vi.fn(async () => {
  throw new TypeError('Failed to fetch');
}) as unknown as typeof fetch;

/* --- I/J: an event with no sources is still an event -------------------- */

describe('I-J. events display without any playback source', () => {
  it('resolves to zero sources without failing, and never claims a provider broke', async () => {
    const result = await resolvePpvPlayback(event(), failingFetch);
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.finalState).toBe('unavailable');
    /* Nothing was requested, so nothing can have failed. */
    expect(result.diagnostics.providers?.every((entry) => entry.requestCount === 0)).toBe(true);
    expect(
      result.diagnostics.providers?.every((entry) => entry.lookupState !== 'attempted'),
    ).toBe(true);
  });

  it('reports official_only when the event carries a validated official link', async () => {
    const result = await resolvePpvPlayback(
      event({ officialWatchUrl: 'https://www.ufc.com/events' }),
      failingFetch,
    );
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.finalState).toBe('official_only');
    expect(result.diagnostics.officialWatchAvailable).toBe(true);
  });

  it('J. skips an unsupported provider rather than calling it a failure', async () => {
    const request = vi.fn() as unknown as typeof fetch;
    const result = await resolvePpvPlayback(event(), request);
    expect(request).not.toHaveBeenCalled();
    expect(result.diagnostics.streamed.lookupState).toBe('not_attempted_unsupported');
    expect(result.diagnostics.finalState).not.toBe('provider_failure');
  });

  it('one playback provider failing never discards another provider sources', async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('streamed.pk')) throw new TypeError('Failed to fetch');
      if (url.includes('api.sportsrc.org')) {
        return json({
          success: true,
          data: { sources: [{ id: 's1', source: 'echo', embedUrl: 'https://embed.streamapi.cc/a/' }] },
        });
      }
      return json([]);
    }) as unknown as typeof fetch;

    const result = await resolvePpvPlayback(
      event({
        sourceRefs: [{ source: 'delta', id: 'x' }],
        providerRefs: { sportsrc: { eventId: 'native-1', category: 'fight' } },
      }),
      request,
    );

    expect(result.sources.map((entry) => entry.url)).toEqual(['https://embed.streamapi.cc/a/']);
    expect(result.diagnostics.streamed.networkErrorCount).toBe(1);
    expect(result.diagnostics.finalState).toBe('playable_candidate');
  });

  it('a provider that throws outright is contained', async () => {
    const exploding = {
      id: 'streamed' as const,
      label: 'streamed',
      supports: () => true,
      resolve: async () => {
        throw new Error('boom');
      },
    };
    const result = await resolvePpvPlayback(event(), failingFetch, [exploding]);
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.providers?.[0].networkErrorCount).toBe(1);
  });

  it('registers every provider under a distinct identity', () => {
    expect(PPV_PLAYBACK_PROVIDERS.map((provider) => provider.id)).toEqual([
      'streamed',
      'sportsrc',
      'youtube',
      'twitch',
    ]);
    expect(streamedPlaybackProvider.supports(event())).toBe(false);
    expect(streamedPlaybackProvider.supports(event({ sourceRefs: [{ source: 'a', id: 'b' }] }))).toBe(
      true,
    );
    expect(sportsrcPlaybackProvider.supports(event())).toBe(false);
  });
});

/* --- K: YouTube adapter -------------------------------------------------- */

describe('K. YouTube authorized embed', () => {
  it('builds the documented no-cookie embed URL from a video id', () => {
    expect(youtubeEmbedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    );
  });

  it('extracts an id only from documented YouTube link shapes', () => {
    expect(youtubeVideoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdFrom('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdFrom('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeVideoIdFrom('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it('refuses look-alike hosts, wrong id shapes and hostile values', () => {
    expect(youtubeVideoIdFrom('https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ')).toBe('');
    expect(youtubeVideoIdFrom('https://evil.example/watch?v=dQw4w9WgXcQ')).toBe('');
    expect(youtubeVideoIdFrom('javascript:alert(1)')).toBe('');
    expect(youtubeVideoIdFrom('../../etc/passwd')).toBe('');
    expect(youtubeVideoIdFrom('short')).toBe('');
    expect(youtubeVideoIdFrom(null)).toBe('');
    expect(youtubeEmbedUrl('not a real id')).toBeUndefined();
  });

  it('resolves a source from an event carrying a documented video id', async () => {
    const result = await youtubePlaybackProvider.resolve(
      event({ providerRefs: { youtube: { videoId: 'dQw4w9WgXcQ' } } }),
      failingFetch,
    );
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].kind).toBe('authorized_embed');
    expect(result.sources[0].url).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
    /* No lookup request is made: the identifier is already the answer. */
    expect(result.diagnostics.requestCount).toBe(0);
  });

  it('makes no embeddability claim of its own', async () => {
    const result = await youtubePlaybackProvider.resolve(
      event({ providerRefs: { youtube: { videoId: 'dQw4w9WgXcQ' } } }),
      failingFetch,
    );
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/embeddable|playback_success|playing/i);
  });
});

/* --- L: Twitch adapter --------------------------------------------------- */

describe('L. Twitch authorized embed', () => {
  it('builds a parent-scoped player URL only for a host we ship on', () => {
    const url = twitchEmbedUrl('someChannel', 'skullygxng.github.io');
    expect(url).toBe(
      'https://player.twitch.tv/?channel=someChannel&parent=skullygxng.github.io&autoplay=false',
    );
  });

  it('refuses to build a source from an origin that is not a declared parent', () => {
    expect(twitchEmbedUrl('someChannel', 'evil.example')).toBeUndefined();
    expect(currentTwitchParent('evil.example')).toBe('');
    expect(currentTwitchParent('skullygxng.github.io')).toBe('skullygxng.github.io');
    expect(PPV_TWITCH_PARENT_HOSTS).not.toContain('evil.example');
  });

  it('validates the channel name shape', () => {
    expect(twitchChannelFrom('good_channel')).toBe('good_channel');
    expect(twitchChannelFrom('@good_channel')).toBe('good_channel');
    expect(twitchChannelFrom('a')).toBe('');
    expect(twitchChannelFrom('bad channel')).toBe('');
    expect(twitchChannelFrom('evil&parent=evil.example')).toBe('');
    expect(twitchChannelFrom(42)).toBe('');
  });

  it('reports an origin that cannot host it as skipped, never as a failure', async () => {
    const result = await twitchPlaybackProvider.resolve(
      event({ providerRefs: { twitch: { channel: 'someChannel' } } }),
      failingFetch,
    );
    /* jsdom serves from localhost, which is a declared parent. */
    const state = result.diagnostics.lookupState;
    expect(['attempted', 'not_attempted_unsupported']).toContain(state);
    expect(result.diagnostics.networkErrorCount).toBe(0);
  });
});

/* --- M: official destinations, watch vs information --------------------- */

describe('M. official destinations', () => {
  it('accepts only HTTPS destinations on the explicit allowlist', () => {
    expect(isAllowedOfficialUrl('https://www.ufc.com/events')).toBe(true);
    expect(isAllowedOfficialUrl('http://www.ufc.com/events')).toBe(false);
    expect(isAllowedOfficialUrl('https://evil.example/ufc')).toBe(false);
    expect(isAllowedOfficialUrl('https://www.ufc.com.evil.example/')).toBe(false);
    expect(isAllowedOfficialUrl('https://user:pass@www.ufc.com/')).toBe(false);
    expect(isAllowedOfficialUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedOfficialUrl('https://127.0.0.1/')).toBe(false);
    expect(isAllowedOfficialUrl('')).toBe(false);
  });

  it('reports why a destination was refused without keeping its path', () => {
    const inspection = inspectOfficialUrl('https://evil.example/watch?token=SECRET');
    expect(inspection.allowed).toBe(false);
    expect(inspection.reason).toBe('host_not_allowlisted');
    expect(inspection.hostname).toBe('evil.example');
    expect(JSON.stringify(inspection)).not.toContain('SECRET');
  });

  it('never turns a promotion into a watch destination', () => {
    /*
     * Knowing an event is a UFC event says nothing about where it can be
     * watched. There is no promotion mapping for watch at all.
     */
    for (const promotion of Object.keys(PPV_OFFICIAL_INFO_BY_PROMOTION)) {
      expect(officialWatchUrlFor({ providedWatchUrl: undefined })).toBeUndefined();
      expect(officialInfoUrlFor({ promotion })).toBeTruthy();
    }
    expect(officialWatchUrlFor({ providedWatchUrl: '' })).toBeUndefined();
  });

  it('never represents a roster or shows page as a watch destination', () => {
    const mapped = Object.values(PPV_OFFICIAL_INFO_BY_PROMOTION);
    /* WWE's roster page must not appear anywhere as a watch destination. */
    expect(mapped).not.toContain('https://www.wwe.com/superstars');
    for (const url of mapped) {
      expect(officialWatchUrlFor({ providedWatchUrl: undefined })).toBeUndefined();
      /* Each mapped page is reachable only through the info accessor. */
      expect(isAllowedOfficialUrl(url)).toBe(true);
    }
  });

  it('accepts an explicitly provided watch destination that passes the allowlist', () => {
    expect(officialWatchUrlFor({ providedWatchUrl: 'https://www.dazn.com/en-US/fight/x' })).toBe(
      'https://www.dazn.com/en-US/fight/x',
    );
    expect(officialWatchUrlFor({ providedWatchUrl: 'https://evil.example/stream' })).toBeUndefined();
    expect(officialWatchUrlFor({ providedWatchUrl: 'http://www.dazn.com/x' })).toBeUndefined();
  });

  it('maps a known promotion to an information page and refuses an untrusted link', () => {
    expect(officialInfoUrlFor({ promotion: 'UFC' })).toBe('https://www.ufc.com/events');
    expect(officialInfoUrlFor({ promotion: 'Unknown Promotion' })).toBeUndefined();
    expect(
      officialInfoUrlFor({ promotion: 'UFC', providedInfoUrl: 'https://evil.example/info' }),
    ).toBe('https://www.ufc.com/events');
  });

  it('every mapped destination is itself on the allowlist', () => {
    for (const host of PPV_OFFICIAL_HOSTS) expect(host).not.toContain('/');
    for (const url of Object.values(PPV_OFFICIAL_INFO_BY_PROMOTION)) {
      expect(isAllowedOfficialUrl(url)).toBe(true);
    }
  });

  it('reports watch and information availability as separate playback outcomes', async () => {
    const watch = await resolvePpvPlayback(
      event({ officialWatchUrl: 'https://www.dazn.com/en-US/fight/x' }),
      failingFetch,
    );
    expect(watch.diagnostics.finalState).toBe('official_only');

    const info = await resolvePpvPlayback(
      event({ officialInfoUrl: 'https://www.ufc.com/events' }),
      failingFetch,
    );
    expect(info.diagnostics.finalState).toBe('official_info_only');
    expect(info.diagnostics.officialWatchAvailable).toBe(false);
    expect(info.diagnostics.officialInfoAvailable).toBe(true);
  });
});

/* --- embed policy is not widened ---------------------------------------- */

describe('embed policy separation', () => {
  it('does not add the authorized platforms to the hosted-embed allowlist', () => {
    expect(PPV_EMBED_HOSTS).toEqual(['embed.st', 'embed.streamapi.cc']);
    expect(isHostedEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(false);
    expect(isHostedEmbedUrl('https://player.twitch.tv/?channel=x&parent=y')).toBe(false);
    expect(isAllowedPpvEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(false);
  });

  it('does not let the authorized policy reach the hosted-embed hosts', () => {
    expect(PPV_AUTHORIZED_EMBED_HOSTS).toEqual(['www.youtube-nocookie.com', 'player.twitch.tv']);
    expect(isAllowedAuthorizedEmbedUrl('https://embed.st/embed/delta/a/1')).toBe(false);
    expect(isAllowedAuthorizedEmbedUrl('http://www.youtube-nocookie.com/embed/x')).toBe(false);
    expect(isAllowedAuthorizedEmbedUrl('https://www.youtube-nocookie.com.evil.example/')).toBe(false);
  });

  it('refuses a mislabelled source that claims the wrong policy', async () => {
    const impostor = {
      id: 'youtube' as const,
      label: 'youtube',
      supports: () => true,
      resolve: async () => ({
        sources: [
          {
            providerId: 'youtube' as const,
            label: 'YouTube',
            kind: 'authorized_embed' as const,
            url: 'https://evil.example/embed',
          },
        ],
        diagnostics: {
          stage: 'youtube' as const,
          provider: 'youtube',
          requestCount: 0,
          completedRequests: 0,
          timeoutCount: 0,
          networkErrorCount: 0,
          httpErrorCount: 0,
          httpStatuses: [],
          malformedResponseCount: 0,
          returnedSourceCount: 1,
          malformedRowCount: 0,
          acceptedEmbedCount: 1,
          rejectedEmbedCount: 0,
          rejectedHosts: [],
          rejectionReasons: [],
        },
      }),
    };
    const result = await resolvePpvPlayback(event(), failingFetch, [impostor]);
    expect(result.sources).toEqual([]);
  });
});

/* --- N/O: player failover and diagnostics -------------------------------- */

describe('N. multi-source failover', () => {
  afterEach(() => vi.useRealTimers());

  const twoSources: PpvEvent = event({
    embeds: [
      { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' },
      { provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/b/' },
    ],
  });

  it('advances to the next source when the frame reports an error', () => {
    render(<PpvPlayer event={twoSources} />);
    const first = document.querySelector('iframe') as HTMLIFrameElement;
    expect(first.getAttribute('src')).toBe('https://embed.st/embed/delta/a/1');
    fireEvent.error(first);
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.streamapi.cc/sport/b/',
    );
  });

  it('advances when no document load event arrives inside the deadline', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={twoSources} />);
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS + 50);
    });
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.streamapi.cc/sport/b/',
    );
  });

  it('stays put when the document did load', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={twoSources} />);
    fireEvent.load(document.querySelector('iframe') as HTMLIFrameElement);
    act(() => {
      vi.advanceTimersByTime(PPV_SOURCE_LOAD_DEADLINE_MS + 50);
    });
    expect((document.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')).toBe(
      'https://embed.st/embed/delta/a/1',
    );
  });

  it('never wraps around past the last source, and says so', () => {
    const single = event({
      embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' }],
    });
    render(<PpvPlayer event={single} debug />);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('No source loaded')).toBeInTheDocument();
    expect(screen.getByLabelText('PPV runtime diagnostics').textContent ?? '').toMatch(
      /exhausted\s*true/i,
    );
  });

  it('records why it advanced, and never as a playback signal', () => {
    render(<PpvPlayer event={twoSources} debug />);
    fireEvent.error(document.querySelector('iframe') as HTMLIFrameElement);
    const text = screen.getByLabelText('PPV runtime diagnostics').textContent ?? '';
    expect(text).toMatch(/iframe_error_event/);
    expect(text).toMatch(/no load event/i);
    expect(text).not.toMatch(/playback_success|playback works|is playing/i);
    expect(text).toMatch(/Neither says whether video played/i);
  });
});

describe('O. official-provider state and diagnostics', () => {
  it('shows the official provider instead of Embed unavailable', async () => {
    render(
      <PpvPlayer
        event={event({ officialWatchUrl: 'https://www.ufc.com/events' })}
        resolveSources={async (target) => ({
          sources: [],
          diagnostics: {
            eventId: target.providerEventId,
            acceptedEmbedCount: 0,
            finalState: 'official_only',
            streamed: {
              stage: 'streamed',
              provider: 'streamed',
              requestCount: 0,
              completedRequests: 0,
              timeoutCount: 0,
              networkErrorCount: 0,
              httpErrorCount: 0,
              httpStatuses: [],
              malformedResponseCount: 0,
              returnedSourceCount: 0,
              malformedRowCount: 0,
              acceptedEmbedCount: 0,
              rejectedEmbedCount: 0,
              rejectedHosts: [],
              rejectionReasons: [],
            },
            sportsrc: {
              stage: 'sportsrc',
              provider: 'sportsrc',
              requestCount: 0,
              completedRequests: 0,
              timeoutCount: 0,
              networkErrorCount: 0,
              httpErrorCount: 0,
              httpStatuses: [],
              malformedResponseCount: 0,
              returnedSourceCount: 0,
              malformedRowCount: 0,
              acceptedEmbedCount: 0,
              rejectedEmbedCount: 0,
              rejectedHosts: [],
              rejectionReasons: [],
            },
          },
        })}
      />,
    );

    expect(await screen.findByText('Watch on official provider')).toBeInTheDocument();
    expect(screen.queryByText('Embed unavailable')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Open official provider' }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://www.ufc.com/events');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    /* Nothing navigates on its own: opening it is a user action. */
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('still says Embed unavailable when there is no official destination', async () => {
    render(<PpvPlayer event={event()} loadEmbeds={async () => []} />);
    expect(await screen.findByText('Embed unavailable')).toBeInTheDocument();
  });

  it('copies an expanded payload that still carries no URLs or credentials', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      render(
        <PpvPlayer
          debug
          event={event({
            officialWatchUrl: 'https://www.ufc.com/events',
            embeds: [
              {
                provider: 'streamed',
                source: 'delta',
                url: 'https://embed.st/embed/delta/a/1?token=SECRET',
              },
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
      const payload = writeText.mock.calls[0][0];
      expect(payload).not.toContain('https://');
      expect(payload).not.toContain('SECRET');
      expect(payload).not.toContain('token=');
      expect(payload).toContain('embed.st');
      expect(payload).toContain('failover');
      expect(payload).toContain('officialWatchAvailable');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
