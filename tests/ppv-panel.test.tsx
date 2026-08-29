import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTvRoute } from '../src/components/LiveTvRoute';
import { PpvPanel } from '../src/components/PpvPanel';
import { PpvPlayer } from '../src/components/PpvPlayer';
import { PpvCatalogError, type PpvCatalog, type PpvEvent } from '../src/lib/ppv';
import type { PpvCatalogDiagnostics } from '../src/lib/ppvDiagnostics';
import { PPV_IFRAME_REFERRER_POLICY, PPV_IFRAME_SANDBOX } from '../src/lib/ppvEmbedPolicy';
import type { LiveTvCatalog } from '../src/lib/iptvOrg';

const catalog: PpvCatalog = {
  source: 'streamed',
  loadedAt: '2026-08-28T20:00:00.000Z',
  events: [
    {
      provider: 'streamed',
      providerEventId: 'ufc-fight-night-286',
      title: 'UFC Fight Night 286 Nurmagomedov vs Song',
      category: 'mma',
      startsAt: '2026-08-29T07:00:00.000Z',
      status: 'upcoming',
      sourceRefs: [{ source: 'delta', id: 'ufc-live' }],
      embeds: [
        { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/ufc-live/1' },
        { provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/backup/' },
      ],
    },
    {
      provider: 'streamed',
      providerEventId: 'wwe-smackdown',
      title: 'WWE Friday Night Smackdown',
      category: 'wrestling',
      startsAt: '2026-08-29T00:00:00.000Z',
      status: 'upcoming',
      sourceRefs: [],
      embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/wwe/1' }],
    },
  ],
};

const liveCatalog: LiveTvCatalog = {
  source: 'iptv-org',
  loadedAt: '2026-08-28T20:00:00.000Z',
  channels: [
    {
      id: 'News.us',
      name: 'News Network',
      displayName: 'News Network',
      logo: null,
      category: 'News',
      categories: ['News'],
      country: 'US',
      streams: [{ url: 'https://example.com/news.m3u8', quality: null, label: null }],
      metadata: [],
    },
  ],
};

describe('Live tab Channels | PPV', () => {
  it('keeps Channels as the default pane and can switch to PPV', async () => {
    render(
      <LiveTvRoute
        loadCatalog={async () => liveCatalog}
        PlayerComponent={() => <div>channel player</div>}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Watch News Network' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'PPV' })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('tab', { name: 'PPV' }));
    expect(screen.getByRole('tab', { name: 'PPV' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: 'Watch News Network' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    expect(screen.getByRole('tab', { name: 'Channels' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: 'Watch News Network' })).toBeInTheDocument();
    expect(screen.getByText(/Choose a channel to start watching live TV/i)).toBeInTheDocument();
  });
});

describe('PPV panel', () => {
  it('renders catalog events and mounts a hosted embed iframe', async () => {
    render(<PpvPanel loadCatalog={async () => catalog} />);

    expect(
      await screen.findByRole('button', { name: 'Watch UFC Fight Night 286 Nurmagomedov vs Song' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch UFC Fight Night 286 Nurmagomedov vs Song' }));

    const frame = document.querySelector('iframe.ppv-player__frame') as HTMLIFrameElement | null;
    expect(frame?.getAttribute('src')).toBe('https://embed.st/embed/delta/ufc-live/1');
    expect(frame?.getAttribute('sandbox')).toBe(PPV_IFRAME_SANDBOX);
    expect(frame?.getAttribute('referrerpolicy') || frame?.referrerPolicy).toBe(PPV_IFRAME_REFERRER_POLICY);
  });

  it('filters categories without losing the catalog', async () => {
    render(<PpvPanel loadCatalog={async () => catalog} />);
    await screen.findByRole('button', { name: 'Watch UFC Fight Night 286 Nurmagomedov vs Song' });

    fireEvent.click(screen.getByRole('button', { name: 'Wrestling' }));
    expect(screen.getByRole('button', { name: 'Watch WWE Friday Night Smackdown' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Watch UFC Fight Night 286 Nurmagomedov vs Song' }),
    ).not.toBeInTheDocument();
  });
});

describe('PPV player', () => {
  const baseEvent: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'empty-event',
    title: 'Empty Event',
    category: 'other',
    startsAt: '2026-08-29T07:00:00.000Z',
    status: 'upcoming',
    sourceRefs: [],
    embeds: [],
  };

  it('shows unavailable when no hosted embed exists', async () => {
    render(<PpvPlayer event={baseEvent} loadEmbeds={async () => []} />);
    expect(await screen.findByText('Embed unavailable')).toBeInTheDocument();
    expect(document.querySelector('iframe.ppv-player__frame')).toBeNull();
  });

  it('switches sources and keeps the required iframe policy', () => {
    render(
      <PpvPlayer
        event={{
          ...baseEvent,
          embeds: [
            { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' },
            { provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/b/' },
          ],
        }}
      />,
    );

    const first = document.querySelector('iframe.ppv-player__frame') as HTMLIFrameElement;
    expect(first.getAttribute('src')).toBe('https://embed.st/embed/delta/a/1');
    expect(first.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms allow-presentation');
    expect(first.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(first.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(first.getAttribute('sandbox')).not.toContain('allow-downloads');
    expect(first.getAttribute('sandbox')).not.toContain('allow-modals');
    expect(first.getAttribute('referrerpolicy') || first.referrerPolicy).toBe('strict-origin-when-cross-origin');

    fireEvent.click(screen.getByRole('button', { name: 'Next PPV source' }));
    const second = document.querySelector('iframe.ppv-player__frame') as HTMLIFrameElement;
    expect(second.getAttribute('src')).toBe('https://embed.streamapi.cc/sport/b/');
    expect(second.getAttribute('sandbox')).toBe(PPV_IFRAME_SANDBOX);
  });
});


describe('PPV mobile watching state', () => {
  /*
   * The mobile stage hides .live-tv-content unless it carries
   * live-tv-stage--watching, and PPV selection never touched Live TV's channel
   * state, so a chosen event could stay hidden on a phone.
   */
  function stage(): HTMLElement {
    return screen.getByRole('main', { name: 'Live TV' });
  }

  it('enters watching state only once a PPV event is chosen, and leaves it on return', async () => {
    render(
      <LiveTvRoute
        loadCatalog={() => Promise.resolve(liveCatalog)}
        loadPpvCatalog={() => Promise.resolve(catalog)}
      />,
    );
    await screen.findByRole('tab', { name: 'PPV' });

    // Channels with nothing selected: not watching, so mobile hides the player.
    expect(stage().className).not.toContain('live-tv-stage--watching');

    fireEvent.click(screen.getByRole('tab', { name: 'PPV' }));
    await screen.findByLabelText('PPV events');
    expect(stage().className).not.toContain('live-tv-stage--watching');

    fireEvent.click(await screen.findByRole('button', { name: /Watch UFC Fight Night 286/ }));

    // Selection must both flip the stage and actually render the player.
    await waitFor(() => expect(stage().className).toContain('live-tv-stage--watching'));
    expect(screen.getByLabelText('PPV player')).toBeInTheDocument();

    // Returning to Channels with no channel selected drops watching again.
    fireEvent.click(screen.getByRole('tab', { name: 'Channels' }));
    await waitFor(() => expect(stage().className).not.toContain('live-tv-stage--watching'));
    expect(screen.queryByLabelText('PPV player')).not.toBeInTheDocument();
  });

  it('still enters watching state for a normal channel', async () => {
    render(
      <LiveTvRoute
        loadCatalog={() => Promise.resolve(liveCatalog)}
        loadPpvCatalog={() => Promise.resolve(catalog)}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Watch News Network' }));
    await waitFor(() => expect(stage().className).toContain('live-tv-stage--watching'));
  });
});

describe('PPV player request races', () => {
  const eventA: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'event-a',
    title: 'Event A',
    category: 'mma',
    startsAt: '2026-08-29T07:00:00.000Z',
    status: 'live',
    sourceRefs: [{ source: 'delta', id: 'a' }],
    embeds: [],
  };
  const eventB: PpvEvent = { ...eventA, providerEventId: 'event-b', title: 'Event B' };

  const embedA = [{ provider: 'streamed' as const, source: 'delta', url: 'https://embed.st/embed/delta/a/1' }];
  const embedB = [{ provider: 'streamed' as const, source: 'delta', url: 'https://embed.st/embed/delta/b/1' }];

  afterEach(() => vi.useRealTimers());

  it('drops the previous event iframe immediately on switch', async () => {
    let resolveB: ((value: typeof embedB) => void) | undefined;
    const loadEmbeds = vi.fn((event: PpvEvent) => {
      if (event.providerEventId === 'event-a') return Promise.resolve(embedA);
      return new Promise<typeof embedB>((resolve) => {
        resolveB = resolve;
      });
    });

    const view = render(<PpvPlayer event={eventA} loadEmbeds={loadEmbeds as never} />);
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedA[0].url),
    );

    view.rerender(<PpvPlayer event={eventB} loadEmbeds={loadEmbeds as never} />);

    // Event A's player must never sit underneath Event B's metadata.
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Event B')).toBeInTheDocument();

    await act(async () => {
      resolveB?.(embedB);
    });
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url),
    );
  });

  it('ignores a late result from the previous event', async () => {
    let resolveA: ((value: typeof embedA) => void) | undefined;
    const loadEmbeds = vi.fn((event: PpvEvent) => {
      if (event.providerEventId === 'event-a') {
        return new Promise<typeof embedA>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(embedB);
    });

    const view = render(<PpvPlayer event={eventA} loadEmbeds={loadEmbeds as never} />);
    view.rerender(<PpvPlayer event={eventB} loadEmbeds={loadEmbeds as never} />);
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url),
    );

    await act(async () => {
      resolveA?.(embedA);
    });

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url);
  });

  it('ignores a late reload of the previous event', async () => {
    let resolveReload: ((value: typeof embedA) => void) | undefined;
    let call = 0;
    const loadEmbeds = vi.fn((event: PpvEvent) => {
      if (event.providerEventId === 'event-a') {
        call += 1;
        if (call === 1) return Promise.resolve(embedA);
        return new Promise<typeof embedA>((resolve) => {
          resolveReload = resolve;
        });
      }
      return Promise.resolve(embedB);
    });

    const view = render(<PpvPlayer event={eventA} loadEmbeds={loadEmbeds as never} />);
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedA[0].url),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload PPV embeds' }));
    view.rerender(<PpvPlayer event={eventB} loadEmbeds={loadEmbeds as never} />);
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url),
    );

    await act(async () => {
      resolveReload?.(embedA);
    });

    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url);
  });

  it('does not let a stale error or empty result clobber the active event', async () => {
    let rejectA: ((reason: Error) => void) | undefined;
    const loadEmbeds = vi.fn((event: PpvEvent) => {
      if (event.providerEventId === 'event-a') {
        return new Promise<typeof embedA>((_resolve, reject) => {
          rejectA = reject;
        });
      }
      return Promise.resolve(embedB);
    });

    const view = render(<PpvPlayer event={eventA} loadEmbeds={loadEmbeds as never} />);
    view.rerender(<PpvPlayer event={eventB} loadEmbeds={loadEmbeds as never} />);
    await waitFor(() =>
      expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url),
    );

    await act(async () => {
      rejectA?.(new Error('event A blew up'));
    });

    expect(screen.queryByText('event A blew up')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(embedB[0].url);
  });
});

describe('PPV failure-state layout', () => {
  it('renders exactly one aspect-ratio viewport while loading and when unavailable', async () => {
    const event: PpvEvent = {
      provider: 'streamed',
      providerEventId: 'event-empty',
      title: 'Empty Event',
      category: 'mma',
      startsAt: '2026-08-29T07:00:00.000Z',
      status: 'live',
      sourceRefs: [],
      embeds: [],
    };

    render(<PpvPlayer event={event} loadEmbeds={() => Promise.resolve([])} />);

    const player = screen.getByLabelText('PPV player');
    // A nested .live-player__video produced a double 16:9 box that squeezed the
    // failure panel on phones.
    expect(player.querySelectorAll('.live-player__video')).toHaveLength(1);
    expect(player.querySelector('.live-player__video .live-player__video')).toBeNull();

    await screen.findByText('Embed unavailable');
    expect(player.querySelectorAll('.live-player__video')).toHaveLength(1);
  });
});

describe('PPV catalog freshness', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks the countdown and flips an upcoming card to live without refetching', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Far enough out to stay upcoming across the ticks: the live window opens
    // 15 minutes before start.
    const start = new Date('2026-08-28T21:00:00.000Z');
    vi.setSystemTime(new Date('2026-08-28T20:00:00.000Z'));

    const single: PpvCatalog = {
      source: 'streamed',
      loadedAt: '2026-08-28T20:00:00.000Z',
      events: [
        {
          provider: 'streamed',
          providerEventId: 'soon',
          title: 'Soon Card',
          category: 'mma',
          startsAt: start.toISOString(),
          status: 'upcoming',
          sourceRefs: [],
          embeds: [],
        },
      ],
    };
    const loadCatalog = vi.fn(() => Promise.resolve(single));
    render(<PpvPanel loadCatalog={loadCatalog as never} />);

    const row = () => screen.getByRole('button', { name: 'Watch Soon Card' }).textContent ?? '';

    await waitFor(() => expect(row()).toMatch(/1h/));

    // The clock alone must move the countdown on, with no refetch.
    await act(async () => {
      vi.setSystemTime(new Date('2026-08-28T20:29:00.000Z'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(row()).not.toMatch(/1h/);
    expect(row()).toMatch(/(29|30|31)m\s/);

    // Crossing the live window flips status from the clock alone.
    await act(async () => {
      vi.setSystemTime(new Date('2026-08-28T20:49:00.000Z'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(row()).toMatch(/LIVE/);
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good catalog when a background refresh fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let call = 0;
    const loadCatalog = vi.fn(() => {
      call += 1;
      return call === 1 ? Promise.resolve(catalog) : Promise.reject(new Error('provider down'));
    });

    render(<PpvPanel loadCatalog={loadCatalog as never} />);
    expect(await screen.findByText('UFC Fight Night 286 Nurmagomedov vs Song')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    });

    // The list survives; the failure is surfaced without blanking it.
    expect(screen.getByText('UFC Fight Night 286 Nurmagomedov vs Song')).toBeInTheDocument();
    expect(screen.getByText(/Showing the last loaded fight cards/)).toBeInTheDocument();
  });

  it('does not overlap catalog refreshes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let resolveSecond: ((value: PpvCatalog) => void) | undefined;
    let call = 0;
    const loadCatalog = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(catalog);
      return new Promise<PpvCatalog>((resolve) => {
        resolveSecond = resolve;
      });
    });

    render(<PpvPanel loadCatalog={loadCatalog as never} />);
    await screen.findByText('UFC Fight Night 286 Nurmagomedov vs Song');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    });
    expect(loadCatalog).toHaveBeenCalledTimes(2);

    // A second interval firing while one request is still in flight must not
    // stack another request on top of it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    });
    expect(loadCatalog).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveSecond?.(catalog);
    });
  });
});


describe('PPV iframe runtime trace and debug mode', () => {
  const traced: PpvEvent = {
    provider: 'streamed',
    providerEventId: 'traced-event',
    title: 'Traced Event',
    category: 'mma',
    startsAt: '2026-08-29T22:00:00.000Z',
    status: 'live',
    sourceRefs: [],
    embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/traced/1?token=SECRET' }],
  };

  afterEach(() => vi.useRealTimers());

  function panel(): HTMLElement {
    return screen.getByLabelText('PPV runtime diagnostics');
  }

  it('is hidden unless debug mode is on', () => {
    render(<PpvPlayer event={traced} debug={false} />);
    expect(screen.queryByLabelText('PPV runtime diagnostics')).not.toBeInTheDocument();
  });

  it('records the iframe hostname only, never the full URL', () => {
    render(<PpvPlayer event={traced} debug />);
    const text = panel().textContent ?? '';
    expect(text).toContain('embed.st');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('token');
    expect(text).not.toContain('SECRET');
  });

  it('does not claim playback before a document load event', () => {
    render(<PpvPlayer event={traced} debug />);
    const text = panel().textContent ?? '';
    expect(text).toMatch(/document load event\s*no/i);
    // The wording must never assert that video is playing.
    expect(text).not.toMatch(/playback_success|playback works|playing/i);
    expect(text).toMatch(/not proof of playback/i);
  });

  it('records the document load event when the frame fires onLoad', () => {
    render(<PpvPlayer event={traced} debug />);
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    fireEvent.load(frame);
    expect(panel().textContent ?? '').toMatch(/document load event\s*yes/i);
  });

  it('clears the previous iframe trace when the event changes', () => {
    const other: PpvEvent = {
      ...traced,
      providerEventId: 'other-event',
      title: 'Other Event',
      embeds: [{ provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/other/' }],
    };

    const view = render(<PpvPlayer event={traced} debug />);
    fireEvent.load(document.querySelector('iframe') as HTMLIFrameElement);
    expect(panel().textContent ?? '').toMatch(/document load event\s*yes/i);

    view.rerender(<PpvPlayer event={other} debug />);
    const text = panel().textContent ?? '';
    expect(text).toContain('embed.streamapi.cc');
    expect(text).not.toContain('embed.st/');
    expect(text).toMatch(/document load event\s*no/i);
  });

  it('copies a sanitized payload with no complete URLs', () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    try {
      render(<PpvPlayer event={traced} debug />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
      expect(writeText).toHaveBeenCalledTimes(1);
      const payload = writeText.mock.calls[0][0];
      expect(payload).not.toContain('https://');
      expect(payload).not.toContain('http://');
      expect(payload).not.toContain('SECRET');
      expect(payload).not.toContain('token=');
      expect(payload).toContain('embed.st');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});


describe('PPV catalog diagnostics in debug mode', () => {
  function endpoint(status: PpvCatalogDiagnostics['fight']['status'], rowCount = 0, httpStatus: number | null = null) {
    return { status, httpStatus, rowCount };
  }

  const loadedDiagnostics: PpvCatalogDiagnostics = {
    stage: 'catalog',
    startedAt: 0,
    completedAt: 1,
    fight: endpoint('success', 2),
    live: endpoint('success', 3),
    today: endpoint('timeout'),
    normalizedEvents: 2,
    overallStatus: 'success',
  };

  const failedDiagnostics: PpvCatalogDiagnostics = {
    stage: 'catalog',
    startedAt: 0,
    completedAt: 1,
    fight: endpoint('network_or_cors_error'),
    live: endpoint('success', 3),
    today: endpoint('timeout'),
    normalizedEvents: 0,
    overallStatus: 'network_or_cors_error',
  };

  const emptyDiagnostics: PpvCatalogDiagnostics = {
    ...loadedDiagnostics,
    fight: endpoint('empty_success'),
    live: endpoint('empty_success'),
    today: endpoint('empty_success'),
    normalizedEvents: 0,
    overallStatus: 'empty_success',
  };

  function panel(): HTMLElement {
    return screen.getByLabelText('PPV runtime diagnostics');
  }

  it('stays hidden without debug mode even when the catalog fails', async () => {
    render(
      <PpvPanel loadCatalog={(() => Promise.reject(new PpvCatalogError(failedDiagnostics))) as never} />,
    );
    expect(await screen.findByText('PPV could not load')).toBeInTheDocument();
    expect(screen.queryByLabelText('PPV runtime diagnostics')).not.toBeInTheDocument();
  });

  it('shows catalog diagnostics when the catalog fails before any event exists', async () => {
    render(
      <PpvPanel debug loadCatalog={(() => Promise.reject(new PpvCatalogError(failedDiagnostics))) as never} />,
    );

    await screen.findByText('PPV could not load');
    // No event can be selected here, so the player - and its panel - never mount.
    expect(screen.queryByLabelText('PPV player')).not.toBeInTheDocument();
    const text = panel().textContent ?? '';
    expect(text).toMatch(/fight status\s*network_or_cors_error/i);
    expect(text).toMatch(/live status\s*success/i);
    expect(text).toMatch(/today status\s*timeout/i);
  });

  it('keeps URLs out of the failure it renders', async () => {
    render(
      <PpvPanel debug loadCatalog={(() => Promise.reject(new PpvCatalogError(failedDiagnostics))) as never} />,
    );
    await screen.findByText('PPV could not load');
    const content = document.body.textContent ?? '';
    expect(content).not.toContain('https://');
    expect(content).not.toContain('streamed.pk');
    expect(content).not.toContain('/api/matches');
  });

  it('replaces a URL-bearing error message with the generic line', async () => {
    render(
      <PpvPanel
        debug
        loadCatalog={(() =>
          Promise.reject(new Error('PPV request timed out: https://streamed.pk/api/matches/fight'))) as never}
      />,
    );
    await screen.findByText('PPV could not load');
    expect(document.body.textContent ?? '').not.toContain('https://');
    expect(screen.getByText('PPV events could not load.')).toBeInTheDocument();
  });

  it('shows catalog diagnostics when the catalog is empty', async () => {
    render(
      <PpvPanel
        debug
        loadCatalog={(() =>
          Promise.resolve({ ...catalog, events: [], diagnostics: emptyDiagnostics })) as never}
      />,
    );
    await screen.findByText('No PPV events found');
    expect(panel().textContent ?? '').toMatch(/overall\s*empty_success/i);
  });

  it('shows catalog diagnostics when the catalog loaded but nothing is selected', async () => {
    render(
      <PpvPanel debug loadCatalog={(() => Promise.resolve({ ...catalog, diagnostics: loadedDiagnostics })) as never} />,
    );
    await screen.findByRole('button', { name: /Watch UFC Fight Night 286/ });
    const text = panel().textContent ?? '';
    expect(text).toMatch(/overall\s*success/i);
    expect(text).toMatch(/normalized events\s*2/i);
    // Nothing is selected yet, so the playback sections have nothing to report.
    expect(text).not.toMatch(/document load event/i);
  });

  it('shows catalog, provider and iframe diagnostics once an event is selected', async () => {
    render(
      <PpvPanel debug loadCatalog={(() => Promise.resolve({ ...catalog, diagnostics: loadedDiagnostics })) as never} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Watch UFC Fight Night 286/ }));

    const text = panel().textContent ?? '';
    expect(text).toMatch(/fight status\s*success/i);
    expect(text).toMatch(/final state/i);
    expect(text).toMatch(/document load event/i);
    expect(text).toContain('embed.st');
    expect(document.querySelectorAll('.ppv-diag')).toHaveLength(1);
  });
});

describe('PPV diagnostics copy states', () => {
  const catalogDiagnostics: PpvCatalogDiagnostics = {
    stage: 'catalog',
    startedAt: 0,
    completedAt: 1,
    fight: { status: 'http_error', httpStatus: 503, rowCount: 0 },
    live: { status: 'empty_success', httpStatus: null, rowCount: 0 },
    today: { status: 'empty_success', httpStatus: null, rowCount: 0 },
    normalizedEvents: 0,
    overallStatus: 'http_error',
  };

  function renderCatalogOnly() {
    return render(
      <PpvPanel debug loadCatalog={(() => Promise.reject(new PpvCatalogError(catalogDiagnostics))) as never} />,
    );
  }

  function copyButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Copy diagnostics' });
  }

  afterEach(() => vi.unstubAllGlobals());

  it('copies a catalog-only payload and reports success once the write resolves', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    renderCatalogOnly();
    await screen.findByText('PPV could not load');
    fireEvent.click(copyButton());

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0];
    expect(payload).toContain('http_error');
    expect(payload).toContain('503');
    expect(payload).not.toContain('https://');
    expect(payload).not.toContain('http://');
    await waitFor(() => expect(copyButton().textContent).toContain('Copied'));
  });

  it('reports a failure when the clipboard write rejects, and keeps the text selectable', async () => {
    const writeText = vi.fn((_text: string) => Promise.reject(new Error('denied')));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    renderCatalogOnly();
    await screen.findByText('PPV could not load');
    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toContain('Copy failed'));
    expect(copyButton().textContent).not.toContain('Copied');
    const fallback = screen.getByLabelText('Diagnostics text') as HTMLTextAreaElement;
    expect(fallback.value).toContain('http_error');
    expect(fallback.value).not.toContain('https://');
  });

  it('reports a failure when the clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });

    renderCatalogOnly();
    await screen.findByText('PPV could not load');
    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toContain('Copy failed'));
    expect(screen.getByLabelText('Diagnostics text')).toBeInTheDocument();
  });
});
