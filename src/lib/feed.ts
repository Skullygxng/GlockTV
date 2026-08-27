import { scoreMatch, type MediaItem } from './media';
import { mediaKey } from './session';

export interface FeedTaste {
  likedGenreIds: number[];
  skippedGenreIds: number[];
  selectedGenreIds?: number[];
}

function hashSeed(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let result = Math.imul(state ^ (state >>> 15), 1 | state);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function sessionFeedSeed() {
  try {
    const stored = sessionStorage.getItem('glocktv:feed-seed');
    if (stored) return stored;
    const next = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('glocktv:feed-seed', next);
    return next;
  } catch {
    return new Date().toISOString().slice(0, 13);
  }
}

export function rotateFeed<T>(items: T[], seed: string) {
  if (items.length < 8) return items;
  const offset = hashSeed(seed) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export function composeDiscoverFeed(items: MediaItem[], taste: FeedTaste, seed = sessionFeedSeed()) {
  const ranked = [...items].sort((left, right) => {
    const leftScore = scoreMatch(left, {
      selectedGenreIds: taste.selectedGenreIds ?? [],
      likedGenreIds: taste.likedGenreIds,
      skippedGenreIds: taste.skippedGenreIds,
    });
    const rightScore = scoreMatch(right, {
      selectedGenreIds: taste.selectedGenreIds ?? [],
      likedGenreIds: taste.likedGenreIds,
      skippedGenreIds: taste.skippedGenreIds,
    });
    if (rightScore !== leftScore) return rightScore - leftScore;
    return right.popularity - left.popularity;
  });

  const movies = ranked.filter((item) => item.mediaType === 'movie');
  const shows = ranked.filter((item) => item.mediaType === 'tv');
  const mixed: MediaItem[] = [];
  const limit = Math.max(movies.length, shows.length);
  for (let index = 0; index < limit; index += 1) {
    if (movies[index]) mixed.push(movies[index]);
    if (shows[index]) mixed.push(shows[index]);
  }

  return rotateFeed(mixed.length ? mixed : ranked, seed);
}

export function mergeFeed(current: MediaItem[], incoming: MediaItem[]) {
  const seen = new Set(current.map((item) => mediaKey(item)));
  const next = [...current];
  for (const item of incoming) {
    const key = mediaKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(item);
  }
  return next;
}

export function pickNextLoungeTitle(pool: MediaItem[], currentTitleId?: number) {
  return pool.find((item) => item.id !== currentTitleId) ?? pool[0] ?? null;
}
