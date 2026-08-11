export type MediaType = 'movie' | 'tv';

export interface MediaItem {
  id: number;
  mediaType: MediaType;
  title: string;
  overview: string;
  date: string;
  year: string;
  genreIds: number[];
  genres: string[];
  rating: number;
  voteCount: number;
  popularity: number;
  runtime: number | null;
  posterPath: string | null;
  backdropPath: string | null;
}

export interface RawMedia {
  id: number;
  title?: string;
  name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  genres?: Array<{ id: number; name: string }>;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  runtime?: number;
  episode_run_time?: number[];
  poster_path?: string | null;
  backdrop_path?: string | null;
}

export interface VideoResult {
  key: string;
  site: string;
  type: string;
  official?: boolean;
  name?: string;
}

export function normalizeMedia(
  raw: RawMedia,
  mediaType: MediaType,
  genreMap: Map<number, string>,
): MediaItem {
  const date = mediaType === 'movie' ? raw.release_date ?? '' : raw.first_air_date ?? '';
  const genreIds = raw.genre_ids ?? raw.genres?.map((genre) => genre.id) ?? [];
  const genres = raw.genres?.map((genre) => genre.name)
    ?? genreIds.map((id) => genreMap.get(id)).filter((genre): genre is string => Boolean(genre));

  return {
    id: raw.id,
    mediaType,
    title: (mediaType === 'movie' ? raw.title : raw.name) ?? raw.title ?? raw.name ?? 'Untitled',
    overview: raw.overview ?? '',
    date,
    year: date ? date.slice(0, 4) : '—',
    genreIds,
    genres,
    rating: Number((raw.vote_average ?? 0).toFixed(1)),
    voteCount: raw.vote_count ?? 0,
    popularity: raw.popularity ?? 0,
    runtime: raw.runtime ?? raw.episode_run_time?.[0] ?? null,
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
  };
}

export function imageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export function scoreMatch(
  item: MediaItem,
  signals: {
    selectedGenreIds: number[];
    likedGenreIds: number[];
    skippedGenreIds: number[];
  },
): number {
  const selectedMatches = item.genreIds.filter((id) => signals.selectedGenreIds.includes(id)).length;
  const likedMatches = item.genreIds.filter((id) => signals.likedGenreIds.includes(id)).length;
  const skippedMatches = item.genreIds.filter((id) => signals.skippedGenreIds.includes(id)).length;
  const ratingSignal = Math.min(12, Math.max(0, (item.rating - 5) * 2));
  const popularitySignal = Math.min(7, Math.log10(Math.max(item.popularity, 1)) * 3);
  const rawScore = 58 + ratingSignal + popularitySignal + selectedMatches * 7 + likedMatches * 5 - skippedMatches * 5;
  return Math.max(55, Math.min(99, Math.round(rawScore)));
}

export function pickTrailer(videos: VideoResult[]): VideoResult | null {
  const youtube = videos.filter((video) => video.site.toLowerCase() === 'youtube');
  return youtube.find((video) => video.type === 'Trailer' && video.official)
    ?? youtube.find((video) => video.type === 'Trailer')
    ?? youtube.find((video) => video.official)
    ?? youtube[0]
    ?? null;
}
