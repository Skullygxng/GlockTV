import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MediaCard } from '../src/components/MediaCard';
import type { MediaItem } from '../src/lib/media';

const item: MediaItem = {
  id: 475557,
  mediaType: 'movie',
  title: 'Joker',
  overview: 'A failed comedian descends into madness.',
  date: '2019-10-01',
  year: '2019',
  genreIds: [80, 18],
  genres: ['Crime', 'Drama'],
  rating: 8.2,
  voteCount: 25000,
  popularity: 98,
  runtime: 122,
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
};

describe('autoplay trailer preview', () => {
  it('renders the active TMDB YouTube trailer as a muted looping autoplay preview', () => {
    render(
      <MediaCard
        item={item}
        match={93}
        saved={false}
        trailerKey="official-trailer-key"
        onToggleList={vi.fn()}
        onWatch={vi.fn()}
        onTrailer={vi.fn()}
        onLike={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    const preview = screen.getByTitle('Joker autoplay trailer');
    expect(preview).toHaveAttribute('src', expect.stringContaining('autoplay=1'));
    expect(preview).toHaveAttribute('src', expect.stringContaining('mute=1'));
    expect(preview).toHaveAttribute('src', expect.stringContaining('loop=1'));
    expect(preview).toHaveAttribute('src', expect.stringContaining('playlist=official-trailer-key'));
  });
});

