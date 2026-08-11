import type { MediaType } from './media';

export type ContentType = 'movies' | 'tv' | 'both';
export type RuntimeFilter = 'any' | 'under-90' | '90-120' | 'over-120';
export type ReleaseEra = 'any' | 'new' | '2020s' | '2010s' | '2000s' | '90s' | 'classics';

export interface DiscoveryFilters {
  contentType: ContentType;
  genreIds: number[];
  releaseEra: ReleaseEra;
  rating: number | null;
  runtime: RuntimeFilter;
  sort: 'popularity' | 'rating' | 'newest';
}

export interface DiscoveryQuery {
  mediaType: MediaType;
  params: Record<string, string>;
}

function dateRange(era: ReleaseEra): { start?: string; end?: string } {
  const currentYear = new Date().getUTCFullYear();
  const ranges: Record<Exclude<ReleaseEra, 'any' | 'new'>, [number, number]> = {
    '2020s': [2020, 2029],
    '2010s': [2010, 2019],
    '2000s': [2000, 2009],
    '90s': [1990, 1999],
    classics: [1900, 1989],
  };
  if (era === 'any') return {};
  if (era === 'new') return { start: `${currentYear - 1}-01-01` };
  const [start, end] = ranges[era];
  return { start: `${start}-01-01`, end: `${end}-12-31` };
}

function paramsFor(filters: DiscoveryFilters, mediaType: MediaType): Record<string, string> {
  const params: Record<string, string> = {
    language: 'en-US',
    include_adult: 'false',
    page: '1',
    sort_by: filters.sort === 'rating'
      ? 'vote_average.desc'
      : filters.sort === 'newest'
        ? mediaType === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc'
        : 'popularity.desc',
    'vote_count.gte': filters.sort === 'rating' ? '100' : '25',
  };
  if (filters.genreIds.length) params.with_genres = filters.genreIds.join('|');
  if (filters.rating !== null) params['vote_average.gte'] = String(filters.rating);
  if (filters.runtime === 'under-90') params['with_runtime.lte'] = '89';
  if (filters.runtime === '90-120') {
    params['with_runtime.gte'] = '90';
    params['with_runtime.lte'] = '120';
  }
  if (filters.runtime === 'over-120') params['with_runtime.gte'] = '121';
  const range = dateRange(filters.releaseEra);
  const dateKey = mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (range.start) params[`${dateKey}.gte`] = range.start;
  if (range.end) params[`${dateKey}.lte`] = range.end;
  return params;
}

export function buildDiscoveryQueries(filters: DiscoveryFilters): DiscoveryQuery[] {
  const mediaTypes: MediaType[] = filters.contentType === 'both'
    ? ['movie', 'tv']
    : [filters.contentType === 'movies' ? 'movie' : 'tv'];
  return mediaTypes.map((mediaType) => ({ mediaType, params: paramsFor(filters, mediaType) }));
}
