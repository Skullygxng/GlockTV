import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESUME_NOTICE_MS } from '../src/components/PlaybackModal';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import { PLAYBACK_PROGRESS_KEY } from '../src/lib/playbackProgress';
import { entryKey, type ProgressEntry } from '../src/lib/watchProgress';
import type { WatchProgressService } from '../src/lib/watchProgressService';

/*
 * Continue Watching as a viewer meets it.
 *
 * The surface deliberately reuses the card feed rather than inventing a rail:
 * the mobile layout is one full-height card with no spare vertical room, and a
 * sixth destination in a five-slot tab bar is exactly the regression this
 * repository has already shipped once.
 */

const movie: MediaItem = {
  id: 533535, mediaType: 'movie', title: 'Deadpool & Wolverine', overview: 'Two heroes collide.',
  date: '2024-07-24', year: '2024', genreIds: [28], genres: ['Action'], rating: 7.7,
  voteCount: 1000, popularity: 90, runtime: 128, posterPath: null, backdropPath: null,
};
const series: MediaItem = { ...movie, id: 1396, mediaType: 'tv', title: 'Breaking Bad', runtime: 47 };

const config = {
  movieUrlTemplate: 'https://video.example/embed/movie/{tmdb_id}',
  tvUrlTemplate: 'https://video.example/embed/tv/{tmdb_id}/{season_number}/{episode_number}',
};

function clientFor(items: MediaItem[]) {
  return {
    getTrending: vi.fn().mockResolvedValue(items),
    discover: vi.fn().mockResolvedValue(items),
    search: vi.fn().mockResolvedValue(items),
    getTitleContext: vi.fn().mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: items[0] }),
    getPersonCredits: vi.fn().mockResolvedValue([]),
    getTvSeriesGuide: vi.fn().mockResolvedValue([
      { id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: 3, posterPath: null, airDate: '2008-01-20' },
    ]),
    getTvSeason: vi.fn().mockResolvedValue([
      { id: 11, episodeNumber: 1, name: 'Pilot', overview: '', stillPath: null, airDate: '2008-01-20', runtime: 58 },
      { id: 12, episodeNumber: 2, name: 'Cat', overview: '', stillPath: null, airDate: '2008-01-27', runtime: 48 },
      { id: 13, episodeNumber: 3, name: 'Bit', overview: '', stillPath: null, airDate: '2008-02-03', runtime: 48 },
    ]),
  };
}

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    mediaType: 'movie', mediaId: 533535, seasonNumber: 0, episodeNumber: 0,
    positionSeconds: 3600, durationSeconds: 7200, completed: false, providerId: 'primary',
    title: 'Deadpool & Wolverine', posterPath: null, backdropPath: null,
    updatedAt: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

function serviceWith(entries: ProgressEntry[]) {
  const rows = new Map(entries.map((item) => [entryKey(item), item]));
  const removes: string[] = [];
  const service: WatchProgressService = {
    list: async () => ({ entries: [...rows.values()], error: '' }),
    save: async () => true,
    remove: async (identity) => { removes.push(entryKey(identity)); rows.delete(entryKey(identity)); return true; },
  };
  return { service, removes };
}

async function openContinueWatching() {
  fireEvent.click(await screen.findByRole('button', { name: 'Mobile My List' }));
  fireEvent.click(await screen.findByRole('tab', { name: /Continue Watching/ }));
}

beforeEach(() => window.localStorage.clear());

describe('the Continue Watching surface', () => {
  it('lives inside My List rather than taking a sixth tab', async () => {
    const { service } = serviceWith([entry()]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await screen.findByRole('button', { name: 'Mobile My List' });
    const nav = screen.getByRole('navigation', { name: 'Mobile navigation' });
    /* Live TV portals its own button in at runtime, so the static markup holds
       four and the fifth arrives from outside. Six would be the regression. */
    expect(within(nav).getAllByRole('button')).toHaveLength(4);
    expect(within(nav).queryByRole('button', { name: /continue/i })).toBeNull();
  });

  it('shows what is in progress, with where it got to', async () => {
    const { service } = serviceWith([entry()]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();

    expect(await screen.findByRole('heading', { name: 'Continue Watching' })).toBeInTheDocument();
    expect(screen.getByText(/1:00:00 of 2:00:00/)).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Watched' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('offers to resume rather than to start', async () => {
    const { service } = serviceWith([entry()]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByRole('button', { name: /Resume movie/ })).toBeInTheDocument();
  });

  it('shows a timestamp but no bar when the provider never reported a length', async () => {
    /* The honest case: position without duration. A bar would need an invented
       denominator and would lie about how much is left. */
    const { service } = serviceWith([entry({ durationSeconds: undefined })]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByText(/1:00:00 in/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar', { name: 'Watched' })).toBeNull();
  });

  it('keeps a finished title out of the way', async () => {
    const { service } = serviceWith([entry({ positionSeconds: 7100, completed: true })]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByText('Nothing in progress')).toBeInTheDocument();
  });

  it('says what the surface needs rather than looking broken when empty', async () => {
    const { service } = serviceWith([]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByText(/once a player reports where you got to/)).toBeInTheDocument();
  });

  it('leaves My List exactly as it was', async () => {
    const { service } = serviceWith([entry()]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mobile My List' }));
    /* The saved tab is still the one you land on, and it is still empty until
       something is saved. Continue Watching did not take it over. */
    expect(await screen.findByText('Your list is empty')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'My List' })).toHaveAttribute('aria-selected', 'true');
  });

  it('forgets a title when asked, here and in the cloud', async () => {
    const { service, removes } = serviceWith([entry()]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(removes).toContain('movie:533535'));
    expect(await screen.findByText('Nothing in progress')).toBeInTheDocument();
  });
});

describe('resuming the right thing', () => {
  it('opens the exact episode, not the first one', async () => {
    /*
     * The failure this exists to prevent: a viewer four episodes into a series
     * taps Resume and is dropped at S1/E1 with the right title and the wrong
     * story.
     */
    const { service } = serviceWith([entry({
      mediaType: 'tv', mediaId: 1396, seasonNumber: 1, episodeNumber: 3,
      positionSeconds: 900, durationSeconds: 2880, title: 'Breaking Bad',
    })]);
    render(<App client={clientFor([series]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    fireEvent.click(await screen.findByRole('button', { name: /Resume episode/ }));

    const frame = await screen.findByTitle('Breaking Bad playback');
    expect(frame).toHaveAttribute('src', expect.stringContaining('/1396/1/3'));
  });

  it('names the episode on the card so the tile is not ambiguous', async () => {
    const { service } = serviceWith([entry({
      mediaType: 'tv', mediaId: 1396, seasonNumber: 2, episodeNumber: 5,
      positionSeconds: 600, durationSeconds: 2880, title: 'Breaking Bad',
    })]);
    render(<App client={clientFor([series]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByText(/S2 \/ E5/)).toBeInTheDocument();
  });

  it('renders a title this device has never loaded, from the stored snapshot', async () => {
    /* The cross-device case: the feed knows nothing about this id, so the tile
       is drawn entirely from what another device recorded. */
    const { service } = serviceWith([entry({ mediaId: 99999, title: 'Recorded Elsewhere' })]);
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={service} />);

    await openContinueWatching();
    expect(await screen.findByRole('heading', { name: 'Recorded Elsewhere' })).toBeInTheDocument();
  });
});

describe('the player tells you it moved you', () => {
  it('says where it resumed from and offers the other answer', async () => {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:533535': { position: 2400, duration: 7200, serverId: 'primary', updatedAt: '2026-09-02T10:00:00.000Z' },
    }));
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Watch movie|Resume movie/ }));
    const frame = await screen.findByTitle('Deadpool & Wolverine playback');
    /* Resuming stays the default - it is what somebody who left partway
       through almost always wants - so the frame already carries the offset. */
    expect(frame).toHaveAttribute('src', expect.stringContaining('startAt=2400'));

    expect(await screen.findByText('Resumed from 40:00')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start from the beginning' }));
    await waitFor(() => {
      expect(screen.getByTitle('Deadpool & Wolverine playback'))
        .not.toHaveAttribute('src', expect.stringContaining('startAt=2400'));
    });
  });

  it('gets out of the way rather than sitting over the provider controls', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
        'movie:533535': { position: 2400, duration: 7200, serverId: 'primary', updatedAt: '2026-09-02T10:00:00.000Z' },
      }));
      render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={null} />);
      fireEvent.click(await screen.findByRole('button', { name: /Watch movie|Resume movie/ }));
      expect(await screen.findByText('Resumed from 40:00')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(RESUME_NOTICE_MS + 100); });
      expect(screen.queryByText('Resumed from 40:00')).toBeNull();
      /* And the offset it announced is still in force. */
      expect(screen.getByTitle('Deadpool & Wolverine playback'))
        .toHaveAttribute('src', expect.stringContaining('startAt=2400'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when there was nothing to resume', async () => {
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch movie' }));
    await screen.findByTitle('Deadpool & Wolverine playback');
    expect(screen.queryByText(/Resumed from/)).toBeNull();
  });

  it('does not resume something already finished', async () => {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:533535': { position: 7100, duration: 7200, serverId: 'primary', updatedAt: '2026-09-02T10:00:00.000Z', completed: true },
    }));
    render(<App client={clientFor([movie]) as never} playbackConfig={config} watchProgressService={null} />);

    fireEvent.click(await screen.findByRole('button', { name: /Watch movie/ }));
    const frame = await screen.findByTitle('Deadpool & Wolverine playback');
    expect(frame.getAttribute('src')).not.toContain('startAt=7100');
  });
});
