import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

function media(id: number, title: string, over: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    mediaType: 'movie',
    title,
    overview: `${title} overview`,
    date: '2021-12-15',
    year: '2021',
    genreIds: [28],
    genres: ['Action'],
    rating: 7.9,
    voteCount: 1200,
    popularity: 90,
    runtime: 120,
    posterPath: '/p.jpg',
    backdropPath: '/b.jpg',
    ...over,
  };
}

const feedItem = media(1, 'Heat');
const spiderResults = [
  media(634649, 'Spider-Man: No Way Home'),
  media(557, 'Spider-Man'),
  media(1979, 'Spider-Man', { mediaType: 'tv', year: '1994', genres: ['Animation'] }),
];

function client(overrides: Partial<TmdbClient> = {}): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([feedItem]),
    discover: vi.fn().mockResolvedValue([feedItem]),
    search: vi.fn().mockResolvedValue(spiderResults),
    getTitleContext: vi
      .fn()
      .mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: feedItem }),
    getPersonCredits: vi.fn().mockResolvedValue([feedItem]),
    ...overrides,
  };
}

function searchBox(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search' });
}

async function ready() {
  await screen.findByRole('heading', { name: 'Heat' });
}

describe('Discover as-you-type search suggestions', () => {
  afterEach(() => vi.useRealTimers());

  it('suggests matching titles while typing, without submitting', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });

    expect(await screen.findByRole('listbox', { name: 'Search suggestions' })).toBeInTheDocument();
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Spider-Man: No Way Home'),
      expect.stringContaining('Spider-Man'),
      expect.stringContaining('Spider-Man'),
    ]);
    // Typing must not replace the feed; that still needs a pick or a submit.
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
    expect(api.search).toHaveBeenCalledWith('spider man');
  });

  it('distinguishes a movie from a TV result in the list', async () => {
    render(<App client={client()} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });
    const options = await screen.findAllByRole('option');
    expect(options[2].textContent).toContain('TV');
    expect(options[1].textContent).toContain('Movie');
  });

  it('does not query the provider for a one-character query', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 's' } });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(api.search).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument();
  });

  it('debounces a burst of keystrokes into a single request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client();
    render(<App client={api} />);
    await screen.findByRole('heading', { name: 'Heat' });

    for (const value of ['sp', 'spi', 'spid', 'spide', 'spider']) {
      fireEvent.change(searchBox(), { target: { value } });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith('spider');
  });

  it('ignores a slow earlier response that lands after a newer one', async () => {
    let resolveFirst: ((value: MediaItem[]) => void) | undefined;
    let call = 0;
    const search = vi.fn(() => {
      call += 1;
      if (call === 1) return new Promise<MediaItem[]>((resolve) => { resolveFirst = resolve; });
      return Promise.resolve([media(42, 'Batman Begins')]);
    });
    render(<App client={client({ search: search as never })} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider' } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    fireEvent.change(searchBox(), { target: { value: 'batman' } });
    await screen.findByText('Batman Begins');

    await act(async () => {
      resolveFirst?.(spiderResults);
    });

    // The stale answer must not replace what the box now says.
    expect(screen.getByText('Batman Begins')).toBeInTheDocument();
    expect(screen.queryByText('Spider-Man: No Way Home')).not.toBeInTheDocument();
  });

  it('loads the picked title first, with its other matches behind it', async () => {
    render(<App client={client()} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });
    const options = await screen.findAllByRole('option');
    fireEvent.click(options[1]);

    expect(await screen.findByRole('heading', { name: 'Spider-Man' })).toBeInTheDocument();
    // The list closes once a pick is made.
    expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument();
  });

  it('supports arrow-key highlighting and Enter to pick', async () => {
    render(<App client={client()} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByRole('heading', { name: 'Spider-Man' })).toBeInTheDocument();
  });

  it('wraps arrow navigation around both ends of the list', async () => {
    render(<App client={client()} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true'),
    );
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'),
    );
  });

  it('closes the list on Escape without changing the feed', async () => {
    render(<App client={client()} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });

  it('clears the list when the query drops below the minimum', async () => {
    render(<App client={client()} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    fireEvent.change(searchBox(), { target: { value: '' } });
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );
  });

  it('keeps submit-to-search working and closes the list', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(await screen.findByRole('heading', { name: 'Spider-Man: No Way Home' })).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument();
  });

  it('mounts only one suggestion list when the mobile search bar is open', async () => {
    render(<App client={client()} />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Search titles' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search movies and TV shows' }), {
      target: { value: 'spider man' },
    });
    await screen.findAllByRole('option');

    // The desktop bar is display:none on phones, but a hidden duplicate list
    // would still be announced by assistive tech.
    expect(screen.getAllByRole('listbox', { name: 'Search suggestions' })).toHaveLength(1);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('stays quiet when the provider fails rather than showing an error banner', async () => {
    const api = client({ search: vi.fn().mockRejectedValue(new Error('tmdb down')) as never });
    render(<App client={api} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });
    await waitFor(() => expect(api.search).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Search is unavailable right now.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });
});
