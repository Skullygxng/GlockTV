import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

const first: MediaItem = {
  id: 1, mediaType: 'movie', title: 'Heat', overview: 'First title.',
  date: '1995-12-15', year: '1995', genreIds: [80], genres: ['Crime'],
  rating: 8.3, voteCount: 7200, popularity: 90, runtime: 170,
  posterPath: '/heat.jpg', backdropPath: '/heat-bg.jpg',
};

const second: MediaItem = {
  id: 2, mediaType: 'movie', title: 'Collateral', overview: 'Second title.',
  date: '2004-08-06', year: '2004', genreIds: [80], genres: ['Crime'],
  rating: 7.2, voteCount: 5900, popularity: 82, runtime: 120,
  posterPath: '/collateral.jpg', backdropPath: '/collateral-bg.jpg',
};

function makeClient(): TmdbClient {
  return {
    getTrending: vi.fn().mockResolvedValue([first, second]),
    discover: vi.fn().mockResolvedValue([first, second]),
    search: vi.fn().mockResolvedValue([first, second]),
    getTitleContext: vi.fn().mockImplementation(async ({ id }) => ({
      details: id === first.id ? first : second,
      trailer: { key: `trailer-${id}`, site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
    })),
    getPersonCredits: vi.fn().mockResolvedValue([]),
  };
}

describe('TikTok-style feed navigation', () => {
  it('advances one title on a downward wheel gesture', async () => {
    render(<App client={makeClient()} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.wheel(screen.getByRole('main'), { deltaY: 160 });

    expect(await screen.findByRole('heading', { name: 'Collateral' })).toBeInTheDocument();
  });

  it('advances one title on an upward mobile swipe', async () => {
    render(<App client={makeClient()} />);
    await screen.findByRole('heading', { name: 'Heat' });
    const feed = screen.getByRole('main');

    fireEvent.touchStart(feed, { touches: [{ clientY: 620 }] });
    fireEvent.touchEnd(feed, { changedTouches: [{ clientY: 280 }] });

    expect(await screen.findByRole('heading', { name: 'Collateral' })).toBeInTheDocument();
  });

  it('supports ArrowDown and ArrowUp navigation', async () => {
    render(<App client={makeClient()} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(await screen.findByRole('heading', { name: 'Collateral' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });
});

