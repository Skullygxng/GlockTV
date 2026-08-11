import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

describe('visible title enrichment', () => {
  it('hydrates a missing runtime from TMDB title details', async () => {
    const item: MediaItem = {
      id: 10, mediaType: 'movie', title: 'Arrival', overview: 'First contact.',
      date: '2016-11-10', year: '2016', genreIds: [878], genres: ['Science Fiction'],
      rating: 7.6, voteCount: 18000, popularity: 80, runtime: null,
      posterPath: '/arrival.jpg', backdropPath: '/arrival-bg.jpg',
    };
    const enriched = { ...item, runtime: 116 };
    const client: TmdbClient = {
      getTrending: vi.fn().mockResolvedValue([item]),
      discover: vi.fn().mockResolvedValue([item]),
      search: vi.fn().mockResolvedValue([item]),
      getTitleContext: vi.fn().mockResolvedValue({ details: enriched, trailer: null, providers: null, providerLink: null }),
      getPersonCredits: vi.fn().mockResolvedValue([]),
    };

    render(<App client={client} />);

    expect(await screen.findByText('1h 56m')).toBeInTheDocument();
    expect(client.getTitleContext).toHaveBeenCalledWith(expect.objectContaining({ id: 10, mediaType: 'movie' }));
  });
});
