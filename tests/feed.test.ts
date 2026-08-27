import { describe, expect, it } from 'vitest';
import { composeDiscoverFeed, mergeFeed, pickNextLoungeTitle, rotateFeed } from '../src/lib/feed';
import type { MediaItem } from '../src/lib/media';

function title(id: number, mediaType: MediaItem['mediaType'], popularity: number, genreIds: number[]): MediaItem {
  return {
    id,
    mediaType,
    title: `${mediaType}-${id}`,
    overview: '',
    date: '2024-01-01',
    year: '2024',
    genreIds,
    genres: ['Action'],
    rating: 7,
    voteCount: 100,
    popularity,
    runtime: 110,
    posterPath: null,
    backdropPath: null,
  };
}

describe('discover feed ranking', () => {
  it('keeps short mock feeds in their original ranked order', () => {
    const heat = title(1, 'movie', 90, [80]);
    const collateral = title(2, 'movie', 82, [80]);
    expect(composeDiscoverFeed([heat, collateral], {
      likedGenreIds: [],
      skippedGenreIds: [],
    }, 'seed')).toEqual([heat, collateral]);
  });

  it('rotates a long feed so the first card is not always TMDB #1', () => {
    const items = Array.from({ length: 10 }, (_, index) => title(index + 1, 'movie', 100 - index, [28]));
    const rotated = rotateFeed(items, 'glocktv-seed');
    expect(rotated).toHaveLength(10);
    expect(rotated[0]).not.toBe(items[0]);
    expect(rotated).toEqual(expect.arrayContaining(items));
  });

  it('appends unseen titles instead of repeating the same page', () => {
    const current = [title(1, 'movie', 90, [28])];
    const incoming = [title(1, 'movie', 90, [28]), title(2, 'movie', 80, [28])];
    expect(mergeFeed(current, incoming).map((item) => item.id)).toEqual([1, 2]);
  });

  it('picks the next lounge title that is not the current one', () => {
    const pool = [title(10, 'movie', 50, [28]), title(11, 'movie', 40, [35])];
    expect(pickNextLoungeTitle(pool, 10)?.id).toBe(11);
  });
});
