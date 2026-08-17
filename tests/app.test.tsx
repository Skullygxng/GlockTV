import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

const item: MediaItem = {
  id: 1,
  mediaType: 'movie',
  title: 'Heat',
  overview: 'A master thief and a relentless detective collide in Los Angeles.',
  date: '1995-12-15',
  year: '1995',
  genreIds: [80, 18],
  genres: ['Crime', 'Drama'],
  rating: 8.3,
  voteCount: 7200,
  popularity: 90,
  runtime: 170,
  posterPath: '/heat.jpg',
  backdropPath: '/heat-backdrop.jpg',
};

const fakeClient: TmdbClient = {
  getTrending: vi.fn().mockResolvedValue([item]),
  discover: vi.fn().mockResolvedValue([item]),
  search: vi.fn().mockResolvedValue([item]),
  getTitleContext: vi.fn().mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: item }),
  getPersonCredits: vi.fn().mockResolvedValue([item]),
};

describe('GlockTV app', () => {
  it('loads a discovery feed and exposes the mockup-defined controls', async () => {
    render(<App client={fakeClient} />);

    expect(screen.getByText('GLOCKTV')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Heat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open filters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Friends' })).toBeInTheDocument();
  });

  it('opens filters and the Vibe mood picker', async () => {
    render(<App client={fakeClient} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(screen.getByRole('button', { name: 'Open filters' }));
    expect(screen.getByRole('dialog', { name: 'Filter your feed' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vibe' }));
    expect(screen.getByRole('dialog', { name: 'Choose a vibe' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
  });

  it('keeps My List for the current session', async () => {
    render(<App client={fakeClient} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(screen.getByRole('button', { name: 'Add Heat to My List' }));
    fireEvent.click(screen.getByRole('button', { name: 'My List' }));

    await waitFor(() => expect(screen.getByText('Your List')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Heat' })).toBeInTheDocument();
  });
});
