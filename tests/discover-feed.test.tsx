import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

function title(
  id: number,
  name: string,
  popularity: number,
  genreIds: number[],
  genres: string[],
): MediaItem {
  return {
    id,
    mediaType: 'movie',
    title: name,
    overview: `${name} overview.`,
    date: '2024-01-01',
    year: '2024',
    genreIds,
    genres,
    rating: 7.5,
    voteCount: 1000,
    popularity,
    runtime: 110,
    posterPath: `/${id}.jpg`,
    backdropPath: `/${id}-bg.jpg`,
  };
}

function makeClient(catalog: MediaItem[], overrides: Partial<TmdbClient> = {}): TmdbClient {
  const lookup = (item: Pick<MediaItem, 'id' | 'mediaType'>) => (
    catalog.find((entry) => entry.id === item.id && entry.mediaType === item.mediaType) ?? catalog[0]
  );

  return {
    getTrending: vi.fn().mockResolvedValue(catalog),
    discover: vi.fn().mockResolvedValue(catalog),
    search: vi.fn().mockResolvedValue(catalog),
    getPreviewContext: vi.fn().mockImplementation(async (item) => ({
      details: lookup(item),
      trailer: null,
    })),
    getTitleContext: vi.fn().mockImplementation(async (item) => ({
      details: lookup(item),
      trailer: { key: `trailer-${item.id}`, site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
    })),
    getPersonCredits: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('Discover feed composition and modal freshness', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
    sessionStorage.setItem('glocktv:feed-seed', 'glocktv-seed');
  });

  it('does not always show TMDB trending item #1 first on a long feed', async () => {
    const items = Array.from({ length: 10 }, (_, index) => (
      title(index + 1, `Title ${index + 1}`, 100 - index, [28], ['Action'])
    ));
    const client = makeClient(items);

    render(<App client={client} />);

    const heading = await screen.findByRole('heading', { name: /Title \d+/ });
    expect(heading).not.toHaveTextContent('Title 1');
    expect(heading.textContent).toMatch(/^Title \d+$/);
  });

  it('uses updated liked and skipped genres on a later discovery load', async () => {
    const heat = title(1, 'Heat', 90, [80], ['Crime']);
    const actionFlick = title(2, 'Action Flick', 88, [28], ['Action']);
    const actionHit = title(99, 'Action Hit', 200, [28], ['Action']);
    const crimeHit = title(100, 'Crime Hit', 10, [80], ['Crime']);

    const client = makeClient([heat, actionFlick, actionHit, crimeHit], {
      getTrending: vi.fn().mockResolvedValue([heat, actionFlick]),
      discover: vi.fn().mockResolvedValue([actionHit, crimeHit]),
    });

    render(<App client={client} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(screen.getByRole('button', { name: 'Like Heat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not interested in Action Flick' }));
    fireEvent.click(screen.getByRole('button', { name: 'Trending' }));

    await waitFor(() => expect(client.discover).toHaveBeenCalled());
    expect(await screen.findByRole('heading', { name: 'Crime Hit' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Action Hit' })).not.toBeInTheDocument();
  });

  it('keeps the newest title modal when an older details request resolves late', async () => {
    const heat = title(1, 'Heat', 90, [80], ['Crime']);
    const collateral = title(2, 'Collateral', 82, [80], ['Crime']);
    const resolvers = new Map<number, (value: unknown) => void>();

    const client = makeClient([heat, collateral], {
      getTitleContext: vi.fn().mockImplementation(({ id }) => new Promise((resolve) => {
        resolvers.set(id, resolve);
      })),
    });

    render(<App client={client} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(screen.getByRole('button', { name: 'Details for Heat' }));
    await waitFor(() => expect(resolvers.has(1)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next title' }));
    expect(await screen.findByRole('heading', { name: 'Collateral' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details for Collateral' }));
    await waitFor(() => expect(resolvers.has(2)).toBe(true));

    resolvers.get(2)?.({
      details: collateral,
      trailer: null,
      providers: null,
      providerLink: null,
    });

    const dialog = await screen.findByRole('dialog', { name: 'Title details' });
    expect(await within(dialog).findByRole('heading', { name: 'Collateral' })).toBeInTheDocument();

    resolvers.get(1)?.({
      details: heat,
      trailer: null,
      providers: null,
      providerLink: null,
    });

    await waitFor(() => {
      expect(within(dialog).getByRole('heading', { name: 'Collateral' })).toBeInTheDocument();
    });
    expect(within(dialog).queryByRole('heading', { name: 'Heat' })).not.toBeInTheDocument();
  });
});
