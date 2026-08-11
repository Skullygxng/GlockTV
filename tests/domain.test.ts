import { describe, expect, it } from 'vitest';
import { buildDiscoveryQueries } from '../src/lib/discovery';
import {
  imageUrl,
  normalizeMedia,
  pickTrailer,
  scoreMatch,
  type MediaItem,
} from '../src/lib/media';
import { initialSessionState, sessionReducer } from '../src/lib/session';

const joker: MediaItem = {
  id: 475557,
  mediaType: 'movie',
  title: 'Joker',
  overview: 'A failed comedian descends into madness.',
  date: '2019-10-01',
  year: '2019',
  genreIds: [80, 18, 53],
  genres: ['Crime', 'Drama', 'Thriller'],
  rating: 8.2,
  voteCount: 25000,
  popularity: 98,
  runtime: 122,
  posterPath: '/poster.jpg',
  backdropPath: '/backdrop.jpg',
};

describe('TMDB media normalization', () => {
  it('normalizes a movie result into the shared media model', () => {
    const result = normalizeMedia(
      {
        id: 475557,
        title: 'Joker',
        overview: 'A failed comedian descends into madness.',
        release_date: '2019-10-01',
        genre_ids: [80, 18],
        vote_average: 8.2,
        vote_count: 25000,
        popularity: 98,
        poster_path: '/poster.jpg',
        backdrop_path: '/backdrop.jpg',
      },
      'movie',
      new Map([
        [80, 'Crime'],
        [18, 'Drama'],
      ]),
    );

    expect(result).toMatchObject({
      id: 475557,
      mediaType: 'movie',
      title: 'Joker',
      year: '2019',
      genres: ['Crime', 'Drama'],
      rating: 8.2,
    });
  });

  it('normalizes TV names, air dates, and runtimes', () => {
    const result = normalizeMedia(
      {
        id: 1399,
        name: 'Game of Thrones',
        first_air_date: '2011-04-17',
        episode_run_time: [57, 60],
        genre_ids: [18],
        vote_average: 8.5,
      },
      'tv',
      new Map([[18, 'Drama']]),
    );

    expect(result).toMatchObject({
      mediaType: 'tv',
      title: 'Game of Thrones',
      date: '2011-04-17',
      year: '2011',
      runtime: 57,
    });
  });

  it('builds correctly sized TMDB image URLs and preserves fallbacks', () => {
    expect(imageUrl('/poster.jpg', 'w780')).toBe(
      'https://image.tmdb.org/t/p/w780/poster.jpg',
    );
    expect(imageUrl(null, 'original')).toBeNull();
  });
});

describe('discovery filters', () => {
  it('creates movie and TV requests for a mixed feed', () => {
    const queries = buildDiscoveryQueries({
      contentType: 'both',
      genreIds: [27, 53],
      releaseEra: 'new',
      rating: 7,
      runtime: '90-120',
      sort: 'popularity',
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      mediaType: 'movie',
      params: expect.objectContaining({
        with_genres: '27|53',
        'vote_average.gte': '7',
        'with_runtime.gte': '90',
        'with_runtime.lte': '120',
        sort_by: 'popularity.desc',
      }),
    });
    expect(queries[1].mediaType).toBe('tv');
  });
});

describe('recommendation behavior', () => {
  it('raises the score for matching filters and liked genres', () => {
    const neutral = scoreMatch(joker, {
      selectedGenreIds: [],
      likedGenreIds: [],
      skippedGenreIds: [],
    });
    const tailored = scoreMatch(joker, {
      selectedGenreIds: [80],
      likedGenreIds: [18, 53],
      skippedGenreIds: [],
    });

    expect(tailored).toBeGreaterThan(neutral);
    expect(tailored).toBeLessThanOrEqual(99);
    expect(neutral).toBeGreaterThanOrEqual(55);
  });

  it('prefers an official YouTube trailer', () => {
    const trailer = pickTrailer([
      { key: 'teaser', site: 'YouTube', type: 'Teaser', official: true },
      { key: 'other', site: 'Vimeo', type: 'Trailer', official: true },
      { key: 'official', site: 'YouTube', type: 'Trailer', official: true },
    ]);

    expect(trailer?.key).toBe('official');
  });
});

describe('session-only interactions', () => {
  it('toggles a title in My List without mutating the previous state', () => {
    const saved = sessionReducer(initialSessionState, {
      type: 'toggle-list',
      item: joker,
    });
    const removed = sessionReducer(saved, { type: 'toggle-list', item: joker });

    expect(initialSessionState.myList).toHaveLength(0);
    expect(saved.myList).toEqual([joker]);
    expect(removed.myList).toHaveLength(0);
  });

  it('collects genre signals from likes and skips', () => {
    const liked = sessionReducer(initialSessionState, { type: 'like', item: joker });
    const skipped = sessionReducer(liked, { type: 'skip', item: joker });

    expect(liked.likedGenreIds).toEqual(expect.arrayContaining([80, 18, 53]));
    expect(skipped.skippedGenreIds).toEqual(expect.arrayContaining([80, 18, 53]));
  });
});
