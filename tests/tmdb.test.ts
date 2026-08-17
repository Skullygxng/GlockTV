import { describe, expect, it, vi } from 'vitest';
import { createTmdbClient } from '../src/lib/tmdb';

function response(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

describe('TMDB client', () => {
  it('loads and merges movie and TV trending results with genre names', async () => {
    const fetcher = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/genre/movie/list')) return response({ genres: [{ id: 80, name: 'Crime' }] });
      if (url.includes('/genre/tv/list')) return response({ genres: [{ id: 18, name: 'Drama' }] });
      if (url.includes('/trending/movie/')) {
        return response({ results: [{ id: 1, title: 'Heat', release_date: '1995-12-15', genre_ids: [80], popularity: 90 }] });
      }
      return response({ results: [{ id: 2, name: 'Severance', first_air_date: '2022-02-18', genre_ids: [18], popularity: 100 }] });
    });

    const client = createTmdbClient({ apiKey: 'test-key', fetcher });
    const items = await client.getTrending();

    expect(items.map((item) => item.title)).toEqual(['Severance', 'Heat']);
    expect(items[0].genres).toEqual(['Drama']);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('api_key=test-key'), expect.any(Object));
  });

  it('returns provider and official trailer details for a title', async () => {
    const fetcher = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/genre/movie/list') || url.includes('/genre/tv/list')) return response({ genres: [] });
      if (url.includes('/watch/providers')) {
        return response({ results: { US: { link: 'https://www.themoviedb.org/watch', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }] } } });
      }
      return response({
        id: 1,
        title: 'Heat',
        runtime: 170,
        videos: { results: [{ key: 'abc123', site: 'YouTube', type: 'Trailer', official: true }] },
      });
    });

    const client = createTmdbClient({ apiKey: 'test-key', fetcher });
    const context = await client.getTitleContext({ id: 1, mediaType: 'movie' });

    expect(context.trailer?.key).toBe('abc123');
    expect(context.providers?.flatrate?.[0].provider_name).toBe('Netflix');
    expect(context.providerLink).toBe('https://www.themoviedb.org/watch');
  });

  it('loads polished season and episode metadata for TV playback', async () => {
    const fetcher = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/tv/1396/season/2')) return response({ episodes: [{ id: 62085, episode_number: 1, name: 'Seven Thirty-Seven', overview: 'Walt and Jesse face the consequences.', still_path: '/episode.jpg', air_date: '2009-03-08', runtime: 47 }] });
      return response({ seasons: [{ id: 3572, season_number: 0, name: 'Specials', episode_count: 11, poster_path: null }, { id: 3573, season_number: 1, name: 'Season 1', episode_count: 7, poster_path: '/s1.jpg' }, { id: 3575, season_number: 2, name: 'Season 2', episode_count: 13, poster_path: '/s2.jpg' }] });
    });
    const client = createTmdbClient({ apiKey: 'test-key', fetcher });

    const seasons = await client.getTvSeriesGuide(1396);
    const episodes = await client.getTvSeason(1396, 2);

    expect(seasons.map((season) => season.seasonNumber)).toEqual([1, 2]);
    expect(episodes[0]).toMatchObject({ episodeNumber: 1, name: 'Seven Thirty-Seven', stillPath: '/episode.jpg', runtime: 47 });
  });
});
