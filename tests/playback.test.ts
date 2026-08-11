import { describe, expect, it } from 'vitest';
import { buildPlaybackUrl } from '../src/lib/playback';

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
});
