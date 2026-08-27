import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveTvRoute } from '../src/components/LiveTvRoute';
import { LiveTvPlayer } from '../src/components/LiveTvPlayer';
import { clearIptvOrgCatalogCache, type LiveChannel, type LiveTvCatalog } from '../src/lib/iptvOrg';

function makeChannel(
  overrides: Partial<LiveChannel> & Pick<LiveChannel, 'id' | 'name' | 'category'>,
): LiveChannel {
  return {
    displayName: overrides.displayName ?? overrides.name,
    logo: null,
    categories: overrides.categories ?? [overrides.category],
    country: 'US',
    streams: overrides.streams ?? [
      { url: `https://example.com/${overrides.id}.m3u8`, quality: null, label: null },
    ],
    metadata: overrides.metadata ?? [],
    ...overrides,
  };
}

const channels: LiveChannel[] = [
  makeChannel({ id: 'News.us', name: 'News Network', category: 'News' }),
  makeChannel({ id: 'Movies.us', name: 'Movie Channel', category: 'Movies' }),
  makeChannel({ id: 'Sports.us', name: 'Sports Network', category: 'Sports' }),
  ...Array.from({ length: 60 }, (_, i) =>
    makeChannel({
      id: `Extra${i}.us`,
      name: `Extra Channel ${i}`,
      category: i % 2 === 0 ? 'Entertainment' : 'General',
    }),
  ),
];

const catalog: LiveTvCatalog = {
  channels,
  source: 'iptv-org',
  loadedAt: '2026-08-27T00:00:00.000Z',
};

function StubPlayer({ channel }: { channel: LiveChannel }) {
  return <div aria-label="stub live player">Playing {channel.displayName || channel.name}</div>;
}

afterEach(() => {
  clearIptvOrgCatalogCache();
  vi.restoreAllMocks();
});

describe('Live TV route', () => {
  it('loads channels, searches, filters, and selects a channel', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);

    expect(await screen.findByText(/Choose a channel to start watching live TV/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('stub live player')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Watch News Network' }));
    expect(screen.getByText('Playing News Network')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search live channels'), { target: { value: 'movie' } });
    expect(screen.getByRole('button', { name: 'Watch Movie Channel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch News Network' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByLabelText('stub live player')).not.toBeInTheDocument();
      expect(screen.getByText(/Choose a channel to start watching live TV/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Watch Movie Channel' }));
    expect(screen.getByText('Playing Movie Channel')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search live channels'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'News' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Watch News Network' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Watch Movie Channel' })).not.toBeInTheDocument();
  });

  it('does not re-fetch catalog on normal rerenders', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    const { rerender } = render(
      <LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />,
    );
    await screen.findByText(/Choose a channel to start watching live TV/i);
    expect(loadCatalog).toHaveBeenCalledTimes(1);

    rerender(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    rerender(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });

  it('explicit retry triggers a fresh load', async () => {
    const loadCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network down'))
      .mockResolvedValueOnce(catalog);

    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    expect(await screen.findByText(/Live TV could not load/i)).toBeInTheDocument();
    expect(loadCatalog).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(await screen.findByText(/Choose a channel to start watching live TV/i)).toBeInTheDocument();
    expect(loadCatalog).toHaveBeenCalledTimes(2);
  });

  it('filtering or searching clears an incompatible selected channel', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    await screen.findByText(/Choose a channel/i);

    fireEvent.click(screen.getByRole('button', { name: 'Watch News Network' }));
    expect(screen.getByText('Playing News Network')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sports' }));
    await waitFor(() => {
      expect(screen.queryByText('Playing News Network')).not.toBeInTheDocument();
      expect(screen.getByText(/Choose a channel/i)).toBeInTheDocument();
    });
  });

  it('batches channel list and Load more expands it', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    await screen.findByText(/Choose a channel/i);

    expect(screen.getByText('63')).toBeInTheDocument();
    expect(screen.getByText(/showing 50/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch Extra Channel 55' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Watch Extra Channel 55' })).toBeInTheDocument();
    });
  });

  it('search resets visible batch', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);
    await screen.findByText(/Choose a channel/i);

    fireEvent.change(screen.getByLabelText('Search live channels'), {
      target: { value: 'Extra Channel 5' },
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Watch Extra Channel 5' })).toBeInTheDocument();
    });
  });
});

describe('Live TV player failover and autoplay', () => {
  function channelWithStreams(urls: string[]): LiveChannel {
    return makeChannel({
      id: 'Multi.us',
      name: 'Multi Source',
      category: 'News',
      streams: urls.map((url) => ({ url, quality: null, label: null })),
    });
  }

  it('does not treat autoplay rejection as stream failure', async () => {
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.play = vi.fn().mockRejectedValue(
      Object.assign(new Error('play() failed because the user did not interact'), {
        name: 'NotAllowedError',
      }),
    ) as typeof HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.canPlayType = () => 'probably';

    try {
      render(<LiveTvPlayer channel={channelWithStreams(['https://example.com/a.m3u8'])} />);
      await waitFor(() => {
        expect(screen.getByText(/Tap Play to start/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/All sources unavailable/i)).not.toBeInTheDocument();
    } finally {
      HTMLMediaElement.prototype.play = originalPlay;
      HTMLMediaElement.prototype.canPlayType = originalCanPlayType;
    }
  });

  it('resets failure state when channel changes', async () => {
    const originalPlay = HTMLMediaElement.prototype.play;
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined) as typeof HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.canPlayType = () => 'probably';

    try {
      const first = channelWithStreams(['https://example.com/a.m3u8']);
      const second = makeChannel({
        id: 'Other.us',
        name: 'Other Channel',
        category: 'Sports',
        streams: [{ url: 'https://example.com/b.m3u8', quality: null, label: null }],
      });

      const { rerender } = render(<LiveTvPlayer channel={first} />);
      await waitFor(() => expect(screen.getByText('Multi Source')).toBeInTheDocument());

      rerender(<LiveTvPlayer channel={second} />);
      await waitFor(() => expect(screen.getByText('Other Channel')).toBeInTheDocument());
      expect(screen.getByText(/Source 1 of 1/i)).toBeInTheDocument();
    } finally {
      HTMLMediaElement.prototype.play = originalPlay;
      HTMLMediaElement.prototype.canPlayType = originalCanPlayType;
    }
  });
});
