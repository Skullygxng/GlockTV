import type { MediaItem } from './media';

export type MediaKey = `${MediaItem['mediaType']}:${number}`;

export interface SessionState {
  myList: MediaItem[];
  likedKeys: MediaKey[];
  skippedKeys: MediaKey[];
  likedGenreIds: number[];
  skippedGenreIds: number[];
}

export type SessionAction =
  | { type: 'toggle-list'; item: MediaItem }
  | { type: 'like'; item: MediaItem }
  | { type: 'skip'; item: MediaItem };

export const initialSessionState: SessionState = {
  myList: [],
  likedKeys: [],
  skippedKeys: [],
  likedGenreIds: [],
  skippedGenreIds: [],
};

export function mediaKey(item: Pick<MediaItem, 'id' | 'mediaType'>): MediaKey {
  return `${item.mediaType}:${item.id}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter(
    (item): item is number => typeof item === 'number' && Number.isFinite(item),
  ));
}

function mediaKeyArray(value: unknown): MediaKey[] {
  if (!Array.isArray(value)) return [];

  return unique(value.filter((item): item is MediaKey => (
    typeof item === 'string'
    && /^(movie|tv):\d+$/.test(item)
  )));
}

function isMediaItem(value: unknown): value is MediaItem {
  if (!value || typeof value !== 'object') return false;

  const item = value as Partial<MediaItem>;

  return (
    typeof item.id === 'number'
    && Number.isFinite(item.id)
    && (item.mediaType === 'movie' || item.mediaType === 'tv')
    && typeof item.title === 'string'
    && Array.isArray(item.genreIds)
    && Array.isArray(item.genres)
  );
}

function mediaItemArray(value: unknown): MediaItem[] {
  if (!Array.isArray(value)) return [];

  const items = value.filter(isMediaItem);
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = mediaKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sanitizeSessionState(value: unknown): SessionState {
  if (!value || typeof value !== 'object') {
    return initialSessionState;
  }

  const saved = value as Record<string, unknown>;

  /*
   * Older GlockTV sessions used numeric likedIds/skippedIds.
   *
   * Those values cannot safely be migrated because TMDB movie IDs and
   * television IDs belong to separate namespaces. We intentionally retain
   * genre preference signals while dropping ambiguous title-level IDs.
   */
  return {
    myList: mediaItemArray(saved.myList),
    likedKeys: mediaKeyArray(saved.likedKeys),
    skippedKeys: mediaKeyArray(saved.skippedKeys),
    likedGenreIds: numberArray(saved.likedGenreIds),
    skippedGenreIds: numberArray(saved.skippedGenreIds),
  };
}

export function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  const key = mediaKey(action.item);

  if (action.type === 'toggle-list') {
    const exists = state.myList.some(
      (item) => mediaKey(item) === key,
    );

    return {
      ...state,
      myList: exists
        ? state.myList.filter((item) => mediaKey(item) !== key)
        : [...state.myList, action.item],
    };
  }

  if (action.type === 'like') {
    return {
      ...state,
      likedKeys: unique([...state.likedKeys, key]),
      likedGenreIds: unique([
        ...state.likedGenreIds,
        ...action.item.genreIds,
      ]),
    };
  }

  return {
    ...state,
    skippedKeys: unique([...state.skippedKeys, key]),
    skippedGenreIds: unique([
      ...state.skippedGenreIds,
      ...action.item.genreIds,
    ]),
  };
}