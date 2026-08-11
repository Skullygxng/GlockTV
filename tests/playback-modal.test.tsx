import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';

const movie: MediaItem = {
  id: 533535, mediaType: 'movie', title: 'Deadpool & Wolverine', overview: 'Two heroes collide.', date: '2024-07-24', year: '2024',
  genreIds: [28], genres: ['Action'], rating: 7.7, voteCount: 1000, popularity: 90, runtime: 128, posterPath: null, backdropPath: null,
};

const series: MediaItem = { ...movie, id: 1396, mediaType: 'tv', title: 'Breaking Bad', runtime: 47 };
const config = {
  movieUrlTemplate: 'https://video.example/embed/movie/{tmdb_id}',
  tvUrlTemplate: 'https://video.example/embed/tv/{tmdb_id}/{season_number}/{episode_number}',
};

function clientFor(item: MediaItem) {
  return {
    getTrending: vi.fn().mockResolvedValue([item]), discover: vi.fn().mockResolvedValue([item]), search: vi.fn().mockResolvedValue([item]),
    getTitleContext: vi.fn().mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: item }),
    getPersonCredits: vi.fn().mockResolvedValue([item]),
  };
}

describe('authorized playback modal', () => {
  it('opens a configured movie embed from the primary watch action', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: movie.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));

    const frame = screen.getByTitle(`${movie.title} playback`);
    expect(screen.getByRole('dialog', { name: 'Movie player' })).toBeInTheDocument();
    expect(frame).toHaveAttribute('src', 'https://video.example/embed/movie/533535');
  });

  it('reloads the embed when a viewer retries a timed-out provider', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: movie.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));
    const originalFrame = screen.getByTitle(`${movie.title} playback`);

    fireEvent.click(screen.getByRole('button', { name: 'Retry player' }));

    expect(screen.getByTitle(`${movie.title} playback`)).not.toBe(originalFrame);
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://video.example/embed/movie/533535');
  });

  it('fullscreens the GlockTV playback wrapper from a visible control', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));
    const frame = screen.getByTestId('playback-frame');
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(frame, 'requestFullscreen', { configurable: true, value: requestFullscreen });

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));

    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it('lets viewers choose a TV season and episode without leaving the player', async () => {
    render(<App client={clientFor(series) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: series.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));
    fireEvent.change(screen.getByLabelText('Season'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Episode'), { target: { value: '7' } });

    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', 'https://video.example/embed/tv/1396/3/7');
  });
});
