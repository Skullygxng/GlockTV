import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LiveTvRoute } from '../src/components/LiveTvRoute';
import { PpvPanel } from '../src/components/PpvPanel';
import { PpvPlayer } from '../src/components/PpvPlayer';
import { type PpvCatalog, type PpvEvent } from '../src/lib/ppv';
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
  it('renders catalog events and opens a hosted embed', async () => {
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
    expect(first.getAttribute('sandbox')).toBe('allow-scripts allow-presentation');
    expect(first.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(first.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(first.getAttribute('sandbox')).not.toContain('allow-downloads');
    expect(first.getAttribute('referrerpolicy') || first.referrerPolicy).toBe('no-referrer');

    fireEvent.click(screen.getByRole('button', { name: 'Next PPV source' }));
    const second = document.querySelector('iframe.ppv-player__frame') as HTMLIFrameElement;
    expect(second.getAttribute('src')).toBe('https://embed.streamapi.cc/sport/b/');
    expect(second.getAttribute('sandbox')).toBe(PPV_IFRAME_SANDBOX);
  });
});
