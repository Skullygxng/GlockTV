import { buildDiscoveryQueries, type DiscoveryFilters } from './discovery';
import { normalizeMedia, pickTrailer, type MediaItem, type MediaType, type RawMedia, type VideoResult } from './media';

export interface Provider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
}

export interface ProviderRegion {
  link?: string;
  flatrate?: Provider[];
  free?: Provider[];
  ads?: Provider[];
  rent?: Provider[];
  buy?: Provider[];
}

export interface TitleContext {
  details: MediaItem;
  trailer: VideoResult | null;
  providers: ProviderRegion | null;
  providerLink: string | null;
}

export interface TmdbClient {
  getTrending(): Promise<MediaItem[]>;
  discover(filters: DiscoveryFilters): Promise<MediaItem[]>;
  search(query: string): Promise<MediaItem[]>;
  getTitleContext(item: Pick<MediaItem, 'id' | 'mediaType'>): Promise<TitleContext>;
  getPersonCredits(personId: number): Promise<MediaItem[]>;
}

interface ClientOptions {
  apiKey?: string;
  readToken?: string;
  fetcher?: typeof fetch;
}

const API_ROOT = 'https://api.themoviedb.org/3';

function dedupe(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.mediaType}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createTmdbClient({ apiKey, readToken, fetcher = fetch }: ClientOptions): TmdbClient {
  if (!apiKey && !readToken) {
    throw new Error('TMDB authentication is missing. Add VITE_TMDB_API_KEY or VITE_TMDB_READ_TOKEN.');
  }

  const request = async <T>(path: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(`${API_ROOT}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    if (apiKey) url.searchParams.set('api_key', apiKey);
    const response = await fetcher(url.toString(), {
      headers: {
        accept: 'application/json',
        ...(readToken ? { Authorization: `Bearer ${readToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`TMDB request failed (${response.status})`);
    return response.json() as Promise<T>;
  };

  let genrePromise: Promise<Map<number, string>> | null = null;
  const getGenres = () => {
    genrePromise ??= Promise.all([
      request<{ genres: Array<{ id: number; name: string }> }>('/genre/movie/list', { language: 'en-US' }),
      request<{ genres: Array<{ id: number; name: string }> }>('/genre/tv/list', { language: 'en-US' }),
    ]).then(([movie, tv]) => new Map([...movie.genres, ...tv.genres].map((genre) => [genre.id, genre.name])));
    return genrePromise;
  };

  const normalizeList = (results: RawMedia[], mediaType: MediaType, genres: Map<number, string>) =>
    results
      .map((item) => normalizeMedia(item, mediaType, genres));

  return {
    async getTrending() {
      const [genres, movies, shows] = await Promise.all([
        getGenres(),
        request<{ results: RawMedia[] }>('/trending/movie/week', { language: 'en-US' }),
        request<{ results: RawMedia[] }>('/trending/tv/week', { language: 'en-US' }),
      ]);
      return dedupe([
        ...normalizeList(movies.results, 'movie', genres),
        ...normalizeList(shows.results, 'tv', genres),
      ]).sort((a, b) => b.popularity - a.popularity).slice(0, 40);
    },

    async discover(filters) {
      const genres = await getGenres();
      const results = await Promise.all(buildDiscoveryQueries(filters).map(async ({ mediaType, params }) => {
        const payload = await request<{ results: RawMedia[] }>(`/discover/${mediaType}`, params);
        return normalizeList(payload.results, mediaType, genres);
      }));
      return dedupe(results.flat()).sort((a, b) => b.popularity - a.popularity).slice(0, 40);
    },

    async search(query) {
      if (!query.trim()) return [];
      const genres = await getGenres();
      const payload = await request<{ results: Array<RawMedia & { media_type?: string; known_for?: Array<RawMedia & { media_type?: string }> }> }>(
        '/search/multi',
        { query: query.trim(), language: 'en-US', include_adult: 'false', page: '1' },
      );
      const expanded = payload.results.flatMap((result) => result.media_type === 'person' ? result.known_for ?? [] : [result]);
      return dedupe(expanded
        .filter((result) => result.media_type === 'movie' || result.media_type === 'tv')
        .map((result) => normalizeMedia(result, result.media_type as MediaType, genres)))
        .sort((a, b) => b.popularity - a.popularity);
    },

    async getTitleContext(item) {
      const [details, providerPayload] = await Promise.all([
        request<RawMedia & { videos?: { results?: VideoResult[] } }>(`/${item.mediaType}/${item.id}`, {
          language: 'en-US',
          append_to_response: 'videos',
        }),
        request<{ results?: Record<string, ProviderRegion> }>(`/${item.mediaType}/${item.id}/watch/providers`),
      ]);
      const genreMap = new Map((details.genres ?? []).map((genre) => [genre.id, genre.name]));
      const providers = providerPayload.results?.US ?? null;
      return {
        details: normalizeMedia(details, item.mediaType, genreMap),
        trailer: pickTrailer(details.videos?.results ?? []),
        providers,
        providerLink: providers?.link ?? null,
      };
    },

    async getPersonCredits(personId) {
      const genres = await getGenres();
      const payload = await request<{ cast?: Array<RawMedia & { media_type?: string }> }>(`/person/${personId}/combined_credits`, { language: 'en-US' });
      return dedupe((payload.cast ?? [])
        .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
        .map((item) => normalizeMedia(item, item.media_type as MediaType, genres)))
        .sort((a, b) => b.popularity - a.popularity);
    },
  };
}
