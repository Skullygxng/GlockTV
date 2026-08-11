import type { MediaItem } from './media';

export interface SessionState {
  myList: MediaItem[];
  likedIds: number[];
  skippedIds: number[];
  likedGenreIds: number[];
  skippedGenreIds: number[];
}

export type SessionAction =
  | { type: 'toggle-list'; item: MediaItem }
  | { type: 'like'; item: MediaItem }
  | { type: 'skip'; item: MediaItem };

export const initialSessionState: SessionState = {
  myList: [],
  likedIds: [],
  skippedIds: [],
  likedGenreIds: [],
  skippedGenreIds: [],
};

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  if (action.type === 'toggle-list') {
    const exists = state.myList.some(
      (item) => item.id === action.item.id && item.mediaType === action.item.mediaType,
    );
    return {
      ...state,
      myList: exists
        ? state.myList.filter(
          (item) => !(item.id === action.item.id && item.mediaType === action.item.mediaType),
        )
        : [...state.myList, action.item],
    };
  }
  const unique = (values: number[]) => [...new Set(values)];
  if (action.type === 'like') {
    return {
      ...state,
      likedIds: unique([...state.likedIds, action.item.id]),
      likedGenreIds: unique([...state.likedGenreIds, ...action.item.genreIds]),
    };
  }
  return {
    ...state,
    skippedIds: unique([...state.skippedIds, action.item.id]),
    skippedGenreIds: unique([...state.skippedGenreIds, ...action.item.genreIds]),
  };
}
