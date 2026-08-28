import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PlaybackModal } from '../src/components/PlaybackModal';
import type { MediaItem } from '../src/lib/media';
import type { PlaybackConfig } from '../src/lib/playback';

const movie: MediaItem = {
  id: 533535,
  mediaType: 'movie',
  title: 'Deadpool & Wolverine',
  overview: 'Two heroes collide.',
  date: '2024-07-24',
  year: '2024',
  genreIds: [28],
  genres: ['Action'],
  rating: 7.7,
  voteCount: 1000,
  popularity: 90,
  runtime: 128,
  posterPath: null,
  backdropPath: null,
};

const series: MediaItem = {
  ...movie,
  id: 1396,
  mediaType: 'tv',
  title: 'Breaking Bad',
  runtime: 47,
};

function clientFor(item: MediaItem) {
  return {
    getTrending: vi.fn().mockResolvedValue([item]),
    discover: vi.fn().mockResolvedValue([item]),
    search: vi.fn().mockResolvedValue([item]),
    getPreviewContext: vi.fn().mockResolvedValue({ details: item, trailer: null }),
    getTitleContext: vi.fn().mockResolvedValue({
      trailer: null,
      providers: null,
      providerLink: null,
      details: item,
      recommendations: [],
      similar: [],
    }),
    getPersonCredits: vi.fn().mockResolvedValue([item]),
    getTvSeriesGuide: vi.fn().mockResolvedValue([]),
    getTvSeason: vi.fn().mockResolvedValue([]),
  };
}

const mixedConfig: PlaybackConfig = {
  servers: [
    {
      id: 'movie-only',
      label: 'Movie only',
      description: 'Movies only',
      movieUrlTemplate: 'https://movie.example/embed/{tmdb_id}',
    },
    {
      id: 'tv',
      label: 'TV server',
      description: 'TV playback',
      tvUrlTemplate: 'https://tv.example/embed/{tmdb_id}/{season_number}/{episode_number}',
      preferredFor: ['tv'],
    },
  ],
};

const resumeConfig: PlaybackConfig = {
  servers: [
    {
      id: 'auto',
      label: 'Resume server',
      description: 'Supports TV resume',
      tvUrlTemplate: 'https://resume.example/embed/{tmdb_id}/{season_number}/{episode_number}',
      preferredFor: ['tv'],
    },
    {
      id: 'cinesrc',
      label: 'No-resume server',
      description: 'TV resume disabled',
      tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}',
      commandMode: 'cinesrc',
      startTimeParam: 't',
      resumeDisabledFor: ['tv'],
    },
  ],
};

describe('playback iframe hardening', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('playback-open');
    document.body.classList.remove('playback-open');
  });

  it('locks page scrolling while the player is open and restores it on close', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={{ movieUrlTemplate: 'https://video.example/movie/{tmdb_id}' }} />);
    await screen.findByRole('heading', { name: movie.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));

    expect(document.documentElement).toHaveClass('playback-open');
    expect(document.body).toHaveClass('playback-open');

    fireEvent.click(screen.getByRole('button', { name: 'Close player' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Movie player' })).not.toBeInTheDocument());
    expect(document.documentElement).not.toHaveClass('playback-open');
    expect(document.body).not.toHaveClass('playback-open');
  });

  it('only offers servers that can play the active media type', async () => {
    render(<App client={clientFor(series) as never} playbackConfig={mixedConfig} />);
    await screen.findByRole('heading', { name: series.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open server list' }));

    expect(screen.getByRole('menuitem', { name: /TV server/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Movie only/i })).not.toBeInTheDocument();
    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute(
      'src',
      'https://tv.example/embed/1396/1/1',
    );
  });

  it('drops an old timestamp when switching to a provider that cannot resume this media type', async () => {
    localStorage.setItem('glocktv:playback-progress:v1', JSON.stringify({
      'tv:1396:s1:e1': {
        position: 222,
        duration: 2820,
        serverId: 'auto',
        updatedAt: '2026-08-26T22:00:00.000Z',
      },
    }));

    render(<App client={clientFor(series) as never} playbackConfig={resumeConfig} />);
    await screen.findByRole('heading', { name: series.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));

    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute(
      'src',
      'https://resume.example/embed/1396/1/1?startAt=222',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open server list' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /No-resume server/i }));

    const switchedUrl = screen.getByTitle(`${series.title} playback`).getAttribute('src') ?? '';
    expect(switchedUrl).toContain('https://cinesrc.st/embed/tv/1396');
    expect(switchedUrl).toContain('t=0');
    expect(switchedUrl).not.toContain('t=222');
  });

  it('automatically moves to the next server when an iframe never loads', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        {
          id: 'primary',
          label: 'Primary',
          description: 'Primary server',
          movieUrlTemplate: 'https://primary.example/movie/{tmdb_id}',
          commandMode: 'vidzen',
        },
        {
          id: 'backup',
          label: 'Backup',
          description: 'Backup server',
          movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}',
          commandMode: 'vidzen',
        },
      ],
    };
    const client = {
      getTitleContext: vi.fn(() => new Promise(() => undefined)),
    };

    const { unmount } = render(
      <PlaybackModal
        item={movie}
        config={config}
        client={client as never}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute(
      'src',
      'https://primary.example/movie/533535',
    );

    act(() => {
      vi.advanceTimersByTime(15_000);
    });

    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute(
      'src',
      'https://backup.example/movie/533535',
    );

    unmount();
  });

  it('does not treat iframe load as ready and falls over after the timeout', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'primary', label: 'Primary', description: 'Primary server', movieUrlTemplate: 'https://primary.example/movie/{tmdb_id}', commandMode: 'cinesrc' },
        { id: 'backup', label: 'Backup', description: 'Backup server', movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}', commandMode: 'vidzen' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    fireEvent.load(screen.getByTitle(`${movie.title} playback`));
    expect(screen.getByText(/Connecting to Primary/i)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://backup.example/movie/533535');
  });

  it('shows provider unavailable after every configured server fails, then retries from the start', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'primary', label: 'Primary', description: 'Primary server', movieUrlTemplate: 'https://primary.example/movie/{tmdb_id}', commandMode: 'vidzen' },
        { id: 'backup', label: 'Backup', description: 'Backup server', movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}', commandMode: 'cinesrc' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(14_000); });
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByText(/Provider unavailable/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://primary.example/movie/533535');
  });

  it('does not auto-switch a loaded commandMode:none provider just because it emits no playback signal', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'auto', label: 'VidCore', description: 'TV default', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', commandMode: 'none' },
        { id: 'backup', label: 'VidZen Backup', description: 'Backup', movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}', commandMode: 'vidzen' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    fireEvent.load(screen.getByTitle(`${movie.title} playback`));
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://www.vidcore.org/embed/movie/533535');
    expect(screen.getByText(/This server is taking too long/i)).toBeInTheDocument();
  });

  it('still auto-fails CineSrc when no readiness signal arrives', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'cinesrc', label: 'CineSrc', description: 'Signalled', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}', commandMode: 'cinesrc' },
        { id: 'auto', label: 'VidCore', description: 'Fallback', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', commandMode: 'none' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://www.vidcore.org/embed/movie/533535');
  });

  it('still auto-fails VidZen when no readiness signal arrives', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'backup', label: 'VidZen', description: 'Signalled', movieUrlTemplate: 'https://vidzen.fun/movie/{tmdb_id}', commandMode: 'vidzen' },
        { id: 'auto', label: 'VidCore', description: 'Fallback', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', commandMode: 'none' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://www.vidcore.org/embed/movie/533535');
  });

  it('lets the viewer manually pick the next server for commandMode:none', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'auto', label: 'VidCore', description: 'Unsignalled', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', commandMode: 'none' },
        { id: 'backup', label: 'VidZen Backup', description: 'Backup', movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}', commandMode: 'vidzen' },
      ],
    };
    render(<PlaybackModal item={movie} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    act(() => { vi.advanceTimersByTime(14_000); });
    fireEvent.click(screen.getByRole('button', { name: 'Next server' }));
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://backup.example/movie/533535');
  });

  it('does not auto-switch the TV default VidCore provider at 14s', () => {
    vi.useFakeTimers();
    const config: PlaybackConfig = {
      servers: [
        { id: 'cinesrc', label: 'CineSrc', description: 'Movie default', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}', commandMode: 'cinesrc' },
        { id: 'auto', label: 'VidCore', description: 'TV default', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://www.vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}', commandMode: 'none', preferredFor: ['tv'] },
        { id: 'backup', label: 'VidZen Backup', description: 'Backup', movieUrlTemplate: 'https://vidzen.fun/movie/{tmdb_id}', tvUrlTemplate: 'https://vidzen.fun/tv/{tmdb_id}/{season_number}/{episode_number}', commandMode: 'vidzen' },
      ],
    };
    render(<PlaybackModal item={series} config={config} client={{ getTitleContext: vi.fn(() => new Promise(() => undefined)) } as never} onClose={() => undefined} />);
    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', 'https://www.vidcore.org/embed/tv/1396/1/1');
    act(() => { vi.advanceTimersByTime(14_000); });
    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', 'https://www.vidcore.org/embed/tv/1396/1/1');
    expect(screen.getByText(/This server is taking too long/i)).toBeInTheDocument();
  });

});
