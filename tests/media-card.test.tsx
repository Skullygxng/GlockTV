import { fireEvent, render, screen } from '@testing-library/react';
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

describe('MediaCard', () => {
  it('shows movie information and invokes the primary actions', () => {
    const onToggleList = vi.fn();
    const onWatch = vi.fn();
    const onDetails = vi.fn();
    const onTrailer = vi.fn();
    const onLike = vi.fn();
    const onSkip = vi.fn();

    render(
      <MediaCard
        item={item}
        match={93}
        saved={false}
        onToggleList={onToggleList}
        onWatch={onWatch}
        onDetails={onDetails}
        onTrailer={onTrailer}
        onLike={onLike}
        onSkip={onSkip}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Joker' })).toBeInTheDocument();
    expect(screen.getByText('93% GlockTV match')).toBeInTheDocument();
    expect(screen.getByText('2h 2m')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play trailer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Details for Joker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Joker to My List' }));
    fireEvent.click(screen.getByRole('button', { name: 'Like Joker' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not interested in Joker' }));

    expect(onWatch).toHaveBeenCalledWith(item);
    expect(onTrailer).toHaveBeenCalledWith(item);
    expect(onDetails).toHaveBeenCalledWith(item);
    expect(onToggleList).toHaveBeenCalledWith(item);
    expect(onLike).toHaveBeenCalledWith(item);
    expect(onSkip).toHaveBeenCalledWith(item);
  });
});
