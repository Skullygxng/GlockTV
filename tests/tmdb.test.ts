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
});
