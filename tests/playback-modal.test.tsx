import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const multiServerConfig = {
  ...config,
  servers: [
    { id: 'auto', label: 'Glock Auto', description: 'Fast automatic fallback', movieUrlTemplate: config.movieUrlTemplate, tvUrlTemplate: config.tvUrlTemplate },
    { id: 'backup', label: 'Backup stream', description: 'Use when the first server is slow', movieUrlTemplate: 'https://backup.example/movie/{tmdb_id}', tvUrlTemplate: 'https://backup.example/tv/{tmdb_id}/{season_number}/{episode_number}' },
  ],
};

const cineSrcConfig = {
  ...config,
  servers: [
    { id: 'cinesrc', label: 'CineSrc', description: 'Room-ready provider', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}?color=%238b24ed', tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}', commandMode: 'cinesrc' as const, startTimeParam: 't' },
    ...multiServerConfig.servers,
  ],
};

const tvReliableConfig = {
  ...config,
  servers: [
    { id: 'cinesrc', label: 'CineSrc', description: 'Movie default', movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}', commandMode: 'cinesrc' as const, startTimeParam: 't', resumeDisabledFor: ['tv' as const] },
    { id: 'auto', label: 'VidCore', description: 'TV default', movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}', tvUrlTemplate: 'https://www.vidcore.org/embed/tv/{tmdb_id}/{season_number}/{episode_number}', preferredFor: ['tv' as const] },
  ],
};

function clientFor(item: MediaItem) {
  return {
    getTrending: vi.fn().mockResolvedValue([item]), discover: vi.fn().mockResolvedValue([item]), search: vi.fn().mockResolvedValue([item]),
    getTitleContext: vi.fn().mockResolvedValue({ trailer: null, providers: null, providerLink: null, details: item }),
    getPersonCredits: vi.fn().mockResolvedValue([item]),
    getTvSeriesGuide: vi.fn().mockResolvedValue([
      { id: 1, seasonNumber: 1, name: 'Season 1', episodeCount: 2, posterPath: '/season.jpg', airDate: '2008-01-20' },
      { id: 2, seasonNumber: 2, name: 'Season 2', episodeCount: 1, posterPath: '/season-2.jpg', airDate: '2009-03-08' },
    ]),
    getTvSeason: vi.fn().mockImplementation(async (_id: number, season: number) => season === 1 ? [
      { id: 11, episodeNumber: 1, name: 'Pilot', overview: 'A chemistry teacher begins a dangerous new life.', stillPath: '/pilot.jpg', airDate: '2008-01-20', runtime: 58 },
      { id: 12, episodeNumber: 2, name: "Cat's in the Bag...", overview: 'Walt and Jesse clean up after the first cook.', stillPath: '/cat.jpg', airDate: '2008-01-27', runtime: 48 },
    ] : [{ id: 21, episodeNumber: 1, name: 'Seven Thirty-Seven', overview: 'The second season begins.', stillPath: '/737.jpg', airDate: '2009-03-08', runtime: 47 }]),
  };
}

describe('authorized playback modal', () => {
  beforeEach(() => window.localStorage.clear());

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

  it('uses the provider as the only fullscreen control', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));

    expect(screen.queryByRole('button', { name: 'Enter fullscreen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).not.toBeInTheDocument();
  });

  it('presents image-led season and episode choices without raw number fields', async () => {
    render(<App client={clientFor(series) as never} playbackConfig={config} />);
    await screen.findByRole('heading', { name: series.title });

    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));
    expect(await screen.findByRole('heading', { name: 'Episodes' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Season 2' }));
    fireEvent.click(await screen.findByRole('button', { name: /Play episode 1 Seven Thirty-Seven/i }));

    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', 'https://video.example/embed/tv/1396/2/1');
  });

  it('uses the TV-reliable provider by default while preserving the movie default', async () => {
    const { unmount } = render(<App client={clientFor(series) as never} playbackConfig={tvReliableConfig} />);
    await screen.findByRole('heading', { name: series.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));

    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute(
      'src',
      'https://www.vidcore.org/embed/tv/1396/1/1',
    );
    expect(screen.getByRole('button', { name: 'Open server list' })).toHaveTextContent('VidCore');

    unmount();
    render(<App client={clientFor(movie) as never} playbackConfig={tvReliableConfig} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://cinesrc.st/embed/movie/533535?t=0');
  });

  it('does not resume a TV timestamp captured from the displaced provider', async () => {
    window.localStorage.setItem('glocktv:playback-progress:v1', JSON.stringify({
      'tv:1396:s1:e1': { position: 94, duration: 3156, serverId: 'cinesrc', updatedAt: '2026-08-18T12:00:00.000Z' },
    }));
    render(<App client={clientFor(series) as never} playbackConfig={tvReliableConfig} />);
    await screen.findByRole('heading', { name: series.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));

    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute(
      'src',
      'https://www.vidcore.org/embed/tv/1396/1/1',
    );
  });

  it('lets viewers change servers and blocks provider pop-up windows', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={multiServerConfig} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));

    const frame = screen.getByTitle(`${movie.title} playback`);
    expect(frame).toHaveAttribute('sandbox');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups');
    fireEvent.click(screen.getByRole('button', { name: 'Open server list' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Backup stream/i }));
    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute('src', 'https://backup.example/movie/533535');
  });

  it('restores a saved movie position and provider after a page refresh', async () => {
    window.localStorage.setItem('glocktv:playback-progress:v1', JSON.stringify({
      'movie:533535': { position: 321, duration: 7680, serverId: 'backup', updatedAt: '2026-08-17T22:00:00.000Z' },
    }));

    render(<App client={clientFor(movie) as never} playbackConfig={multiServerConfig} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));

    expect(screen.getByTitle(`${movie.title} playback`)).toHaveAttribute(
      'src',
      'https://backup.example/movie/533535?startAt=321',
    );
    expect(screen.getByRole('button', { name: 'Open server list' })).toHaveTextContent('Backup stream');
  });

  it('records CineSrc time updates so the same title can resume later', async () => {
    render(<App client={clientFor(movie) as never} playbackConfig={cineSrcConfig} />);
    await screen.findByRole('heading', { name: movie.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch movie' }));
    const frame = screen.getByTitle(`${movie.title} playback`) as HTMLIFrameElement;

    fireEvent(window, new MessageEvent('message', {
      origin: 'https://cinesrc.st',
      source: frame.contentWindow,
      data: { type: 'cinesrc:timeupdate', currentTime: 187.8, duration: 7680 },
    }));

    const saved = JSON.parse(window.localStorage.getItem('glocktv:playback-progress:v1') ?? '{}');
    expect(saved['movie:533535']).toMatchObject({ position: 187, duration: 7680, serverId: 'cinesrc' });
  });

  it('never carries the previous episode timestamp into a newly selected episode', async () => {
    window.localStorage.setItem('glocktv:playback-progress:v1', JSON.stringify({
      'tv:1396:s1:e1': { position: 321, duration: 3480, serverId: 'cinesrc', updatedAt: '2026-08-18T12:00:00.000Z' },
    }));
    render(<App client={clientFor(series) as never} playbackConfig={cineSrcConfig} />);
    await screen.findByRole('heading', { name: series.title });
    fireEvent.click(screen.getByRole('button', { name: 'Watch episode' }));
    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', expect.stringContaining('t=321'));

    const observedEpisodeUrls: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLIFrameElement && node.src.includes('s=1') && node.src.includes('e=2')) observedEpisodeUrls.push(node.src);
        }
      }
    });
    observer.observe(screen.getByRole('dialog', { name: 'TV player' }), { childList: true, subtree: true });

    fireEvent.click(await screen.findByRole('button', { name: /Play episode 2 Cat's in the Bag/i }));
    await waitFor(() => expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', expect.stringContaining('e=2')));
    observer.disconnect();

    expect(observedEpisodeUrls).not.toEqual(expect.arrayContaining([expect.stringContaining('t=321')]));
    expect(screen.getByTitle(`${series.title} playback`)).toHaveAttribute('src', expect.stringContaining('t=0'));
  });
});
