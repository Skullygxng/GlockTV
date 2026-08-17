import { describe, expect, it } from 'vitest';
import { buildPlaybackUrl, getPlaybackServers } from '../src/lib/playback';

const config = {
  movieUrlTemplate: 'https://video.example/embed/movie/{tmdb_id}',
  tvUrlTemplate: 'https://video.example/embed/tv/{tmdb_id}/{season_number}/{episode_number}',
};

describe('authorized playback URLs', () => {
  it('fills a movie template with the TMDB id', () => {
    expect(buildPlaybackUrl({ id: 533535, mediaType: 'movie' }, config)).toBe('https://video.example/embed/movie/533535');
  });

  it('fills a TV template with the selected season and episode', () => {
    expect(buildPlaybackUrl({ id: 1396, mediaType: 'tv' }, config, { season: 3, episode: 7 })).toBe('https://video.example/embed/tv/1396/3/7');
  });

  it('rejects missing, incomplete, and insecure templates', () => {
    expect(buildPlaybackUrl({ id: 1, mediaType: 'movie' }, {})).toBeNull();
    expect(buildPlaybackUrl({ id: 1, mediaType: 'tv' }, { tvUrlTemplate: 'https://video.example/{tmdb_id}/{season_number}' })).toBeNull();
    expect(buildPlaybackUrl({ id: 1, mediaType: 'movie' }, { movieUrlTemplate: 'http://video.example/{tmdb_id}' })).toBeNull();
  });

  it('builds a clean server list and resolves a selected backup', () => {
    const multiServer = {
      ...config,
      servers: [
        { id: 'auto', label: 'Glock Auto', description: 'Fast automatic fallback', movieUrlTemplate: config.movieUrlTemplate, tvUrlTemplate: config.tvUrlTemplate },
        { id: 'sync', label: 'Room Sync', description: 'Best for watch parties', movieUrlTemplate: 'https://sync.example/movie/{tmdb_id}', tvUrlTemplate: 'https://sync.example/tv/{tmdb_id}/{season_number}/{episode_number}' },
      ],
    };

    expect(getPlaybackServers(multiServer).map(({ id }) => id)).toEqual(['auto', 'sync']);
    expect(buildPlaybackUrl({ id: 533535, mediaType: 'movie' }, multiServer, {}, 'sync')).toBe('https://sync.example/movie/533535');
  });

  it('adds a documented start position without dropping existing player options', () => {
    const url = buildPlaybackUrl(
      { id: 533535, mediaType: 'movie' },
      { movieUrlTemplate: 'https://www.vidcore.org/embed/movie/{tmdb_id}?autoPlay=true&title=false' },
      { startAt: 91 },
    );
    expect(url).toBe('https://www.vidcore.org/embed/movie/533535?autoPlay=true&title=false&startAt=91');
  });

  it('uses a provider-specific start-time parameter when switching to CineSrc', () => {
    const cineSrc = {
      servers: [{
        id: 'cinesrc',
        label: 'CineSrc',
        description: 'Native fullscreen and room controls',
        movieUrlTemplate: 'https://cinesrc.st/embed/movie/{tmdb_id}?color=%238b24ed',
        tvUrlTemplate: 'https://cinesrc.st/embed/tv/{tmdb_id}?s={season_number}&e={episode_number}&color=%238b24ed',
        startTimeParam: 't',
      }],
    } as never;

    expect(buildPlaybackUrl({ id: 27205, mediaType: 'movie' }, cineSrc, { startAt: 125 }, 'cinesrc'))
      .toBe('https://cinesrc.st/embed/movie/27205?color=%238b24ed&t=125');
    expect(buildPlaybackUrl({ id: 1396, mediaType: 'tv' }, cineSrc, { season: 2, episode: 3 }, 'cinesrc'))
      .toBe('https://cinesrc.st/embed/tv/1396?s=2&e=3&color=%238b24ed');
  });
});
