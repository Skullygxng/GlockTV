import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../lib/media';

/*
 * The as-you-type search controller shared by every media search box.
 *
 * It owns exactly one thing: turning a query string into a list of suggestions
 * safely. Debounce, request generations, the stale-term guard, the
 * already-fetched cache and the keyboard contract all live here so a second
 * search surface cannot drift from the first one. Presentation stays with the
 * caller - Discover renders a floating popup, the watch-party picker renders a
 * poster grid - and neither knows how the other fetches.
 */

/* Two characters is the shortest query worth a provider round trip. */
export const SUGGEST_MIN_CHARS = 2;
export const SUGGEST_DEBOUNCE_MS = 250;
export const SUGGEST_LIMIT = 6;

export interface MediaSearchSuggestionsOptions {
  /* Raw input value. The hook trims it; callers keep the untrimmed state. */
  term: string;
  search: (term: string) => Promise<MediaItem[]>;
  /* Invoked when Enter commits the highlighted option. */
  onSelect: (item: MediaItem) => void;
  /*
   * Optional. A lookup failure leaves the box quiet by default, which is right
   * for a popup that overlays the page. A surface that owns the whole panel -
   * the watch-party picker - can use this to say so in its own scoped slot,
   * without a failed suggestion becoming a page-level error.
   */
  onError?: () => void;
  minChars?: number;
  debounceMs?: number;
  limit?: number;
}

export interface MediaSearchSuggestions {
  /*
   * Only ever the results belonging to the term now in the box. Anything else
   * is a leftover from a previous query and must never be rendered,
   * highlighted, or selectable.
   */
  suggestions: MediaItem[];
  /* -1 when nothing is keyboard-highlighted. */
  activeIndex: number;
  loading: boolean;
  open: boolean;
  /* open, and there is something to show: results or the loading row. */
  visible: boolean;
  setOpen: (open: boolean) => void;
  setActiveIndex: (index: number) => void;
  /* Reopen on focus, refetching once if the dismissal cancelled the lookup. */
  openSuggestions: () => void;
  /* Hide and abandon any pending lookup, keeping the cache for a return visit. */
  dismiss: () => void;
  /* Dismiss and drop the cache too - used once a query has been acted on. */
  reset: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
}

export function useMediaSearchSuggestions({
  term,
  search,
  onSelect,
  onError,
  minChars = SUGGEST_MIN_CHARS,
  debounceMs = SUGGEST_DEBOUNCE_MS,
  limit = SUGGEST_LIMIT,
}: MediaSearchSuggestionsOptions): MediaSearchSuggestions {
  const [suggestions, setSuggestions] = useState<MediaItem[]>([]);
  /* The term these suggestions describe. Results for any other term are stale. */
  const [suggestionsForTerm, setSuggestionsForTerm] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [reloadToken, setReloadToken] = useState(0);

  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Mirrors suggestionsForTerm so the request effect can read it without
     re-running every time a response lands. */
  const termRef = useRef('');
  /* Kept in a ref so a caller's inline handler cannot restart the lookup. */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const searchTerm = term.trim();

  const activeSuggestions = suggestionsForTerm === searchTerm ? suggestions : [];
  const boundedIndex = activeIndex < activeSuggestions.length ? activeIndex : -1;
  const visible = open && (loading || activeSuggestions.length > 0);

  const cancelTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    cancelTimer();
    version.current += 1;
    setOpen(false);
    setActiveIndex(-1);
    setLoading(false);
  }, [cancelTimer]);

  const reset = useCallback(() => {
    dismiss();
    termRef.current = '';
    setSuggestionsForTerm('');
    setSuggestions([]);
  }, [dismiss]);

  /*
   * As-you-type suggestions. Debounced so a fast typist costs one request
   * rather than one per keystroke, versioned so a slow earlier response can
   * never replace newer results, and cancellable so submitting or dismissing
   * before the debounce elapses never reaches the provider at all.
   */
  useEffect(() => {
    cancelTimer();

    /*
     * The generation is claimed before any early return. A request already in
     * flight for a different query must be retired even when the query we are
     * moving to is served from cache - otherwise that request lands later and
     * overwrites the cache with results for a term nobody is looking at.
     */
    const requestVersion = ++version.current;

    if (searchTerm.length < minChars) {
      setLoading(false);
      return;
    }

    if (termRef.current === searchTerm) {
      setLoading(false);
      return;
    }

    setLoading(true);

    timer.current = setTimeout(() => {
      timer.current = null;
      void search(searchTerm)
        .then((results) => {
          if (requestVersion !== version.current) return;
          termRef.current = searchTerm;
          setSuggestionsForTerm(searchTerm);
          setSuggestions(results.slice(0, limit));
          setActiveIndex(-1);
        })
        .catch(() => {
          if (requestVersion !== version.current) return;
          /*
           * A failed suggestion is not worth a page-level error banner, so the
           * box just goes quiet unless the caller asked to be told. The term is
           * deliberately left uncached: a provider failure is not a valid empty
           * result, and caching it as one would make the query permanently
           * unretryable.
           */
          onErrorRef.current?.();
        })
        .finally(() => {
          if (requestVersion === version.current) setLoading(false);
        });
    }, debounceMs);

    return cancelTimer;
  }, [cancelTimer, debounceMs, limit, minChars, search, searchTerm, reloadToken]);

  useEffect(() => cancelTimer, [cancelTimer]);

  const openSuggestions = useCallback(() => {
    setOpen(true);
    // Dismissing cancels the lookup, so a return visit to an unchanged query
    // needs one controlled refetch when nothing was cached for it.
    if (searchTerm.length >= minChars && termRef.current !== searchTerm) {
      setReloadToken((token) => token + 1);
    }
  }, [minChars, searchTerm]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    // Escape and Tab are handled before the emptiness guard: the popup can be
    // visible in its loading state with nothing in the list yet.
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        dismiss();
      }
      return;
    }

    // Let Tab move to the next control; the popup just gets out of the way.
    if (event.key === 'Tab') {
      if (open) dismiss();
      return;
    }

    if (!open || !activeSuggestions.length) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => {
        const from = current < activeSuggestions.length ? current : -1;
        const next = from + step;
        if (next < 0) return activeSuggestions.length - 1;
        if (next >= activeSuggestions.length) return 0;
        return next;
      });
      return;
    }

    if (event.key === 'Enter' && boundedIndex >= 0) {
      event.preventDefault();
      onSelect(activeSuggestions[boundedIndex]);
    }
  };

  return {
    suggestions: activeSuggestions,
    activeIndex: boundedIndex,
    loading,
    open,
    visible,
    setOpen,
    setActiveIndex,
    openSuggestions,
    dismiss,
    reset,
    onKeyDown,
  };
}
