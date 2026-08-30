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

/* jsdom has no matchMedia; tests opt into the mobile breakpoint explicitly. */
function stubBreakpoint(mobile: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    // A getter, so a stored MediaQueryList reflects later breakpoint changes
    // the way a real one does.
    get matches() {
      return mobile && query.includes('700px');
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  return {
    set(next: boolean) {
      mobile = next;
      listeners.forEach((listener) => listener());
    },
  };
}

function searchBox(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Search' });
}

async function ready() {
  await screen.findByRole('heading', { name: 'Heat' });
}

describe('Discover as-you-type search suggestions', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
    stubBreakpoint(true);
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


describe('Discover search suggestion hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('drops results of a previous query the moment the query changes', async () => {
    let resolveSpider: ((value: MediaItem[]) => void) | undefined;
    let call = 0;
    const search = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(spiderResults);
      return new Promise<MediaItem[]>((resolve) => { resolveSpider = resolve; });
    });
    render(<App client={client({ search: search as never })} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider' } });
    await screen.findAllByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => expect(input).toHaveAttribute('aria-activedescendant'));

    // Typing a new query must retire the old results immediately, before the
    // debounce for the new one has even started.
    fireEvent.change(input, { target: { value: 'batman' } });

    expect(screen.queryByText('Spider-Man: No Way Home')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-activedescendant');

    // Enter must not resurrect the retired highlight.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByRole('heading', { name: 'Spider-Man' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();

    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveSpider?.([media(42, 'Batman Begins')]);
    });
    expect(await screen.findByText('Batman Begins')).toBeInTheDocument();
  });

  it('keeps suggestion options out of the tab order', async () => {
    render(<App client={client()} />);
    await ready();

    fireEvent.change(searchBox(), { target: { value: 'spider man' } });
    const options = await screen.findAllByRole('option');

    for (const option of options) {
      expect(option).toHaveAttribute('tabindex', '-1');
    }
  });

  it('closes the popup on Tab without swallowing the keypress', async () => {
    render(<App client={client()} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    const tab = fireEvent.keyDown(input, { key: 'Tab' });
    // Not prevented, so the browser still moves focus onward.
    expect(tab).toBe(true);
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );
  });

  it('hands popup ownership to the desktop bar when the viewport leaves mobile', async () => {
    const breakpoint = stubBreakpoint(true);
    render(<App client={client()} />);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Search titles' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search movies and TV shows' }), {
      target: { value: 'spider man' },
    });
    await screen.findAllByRole('option');
    expect(screen.getAllByRole('listbox', { name: 'Search suggestions' })).toHaveLength(1);
    expect(screen.getByRole('listbox', { name: 'Search suggestions' })).toHaveAttribute(
      'id',
      'search-suggestions-mobile',
    );

    // Rotate to a wide viewport: the mobile bar is gone and the visible
    // desktop combobox must own the popup rather than being suppressed.
    await act(async () => {
      breakpoint.set(false);
    });

    await waitFor(() =>
      expect(
        screen.queryByRole('combobox', { name: 'Search movies and TV shows' }),
      ).not.toBeInTheDocument(),
    );
    const lists = screen.getAllByRole('listbox', { name: 'Search suggestions' });
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveAttribute('id', 'search-suggestions-desktop');
    expect(searchBox()).toHaveAttribute('aria-controls', 'search-suggestions-desktop');
  });

  it('cancels a scheduled lookup when the query is submitted first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client();
    render(<App client={api} />);
    await screen.findByRole('heading', { name: 'Heat' });

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    // Submit inside the debounce window.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The scheduled autocomplete request must never reach the provider.
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape while the popup is still loading', async () => {
    let resolveSearch: ((value: MediaItem[]) => void) | undefined;
    const search = vi.fn(() => new Promise<MediaItem[]>((resolve) => { resolveSearch = resolve; }));
    render(<App client={client({ search: search as never })} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    expect(await screen.findByText('Searching...')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );

    // The abandoned response must not reopen the popup.
    await act(async () => {
      resolveSearch?.(spiderResults);
    });
    expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });

  it('restores suggestions on refocus of an unchanged query', async () => {
    const api = client();
    render(<App client={api} />);
    await ready();

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');
    expect(api.search).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument(),
    );

    fireEvent.focus(input);

    // Served from cache: the same query costs no extra provider traffic.
    expect(await screen.findByText('Spider-Man: No Way Home')).toBeInTheDocument();
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it('refetches once on refocus when the dismissal cancelled the lookup', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = client();
    render(<App client={api} />);
    await screen.findByRole('heading', { name: 'Heat' });

    const input = searchBox();
    fireEvent.change(input, { target: { value: 'spider man' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(api.search).not.toHaveBeenCalled();

    fireEvent.focus(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Spider-Man: No Way Home')).toBeInTheDocument();
  });

  it('exposes a truthful combobox contract', async () => {
    render(<App client={client()} />);
    await ready();

    const input = searchBox();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).not.toHaveAttribute('aria-controls');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    fireEvent.change(input, { target: { value: 'spider man' } });
    await screen.findAllByRole('option');

    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'search-suggestions-desktop');
    expect(input).not.toHaveAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    await waitFor(() => {
      const target = input.getAttribute('aria-activedescendant');
      expect(target).toBeTruthy();
      expect(document.getElementById(target as string)).toBeInTheDocument();
    });
  });
});
