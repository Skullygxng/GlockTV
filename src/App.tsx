import { FormEvent, lazy, Suspense, type TouchEvent, type WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell, Bookmark, ChevronDown, ChevronRight, ChevronUp, CircleUser, Clapperboard,
  Compass, Film, Filter, History, LoaderCircle, Play, Search,
  SlidersHorizontal, Sparkles, Star, Users, X, Zap,
} from 'lucide-react';
import { MediaCard } from './components/MediaCard';
import { SearchSuggestions, optionId } from './components/SearchSuggestions';
import { useMediaSearchSuggestions } from './hooks/useMediaSearchSuggestions';
import { useDialogBehavior } from './hooks/useDialogBehavior';
import { AccountPanel } from './components/AccountPanel';
import { AccountProvider, useAccount } from './components/AccountProvider';
import { AdSlot } from './components/AdSlot';
import { WatchProgressProvider } from './components/WatchProgressProvider';
import type { WatchProgressService } from './lib/watchProgressService';
import type { AccountService } from './lib/accountService';
import type { BillingService } from './lib/billing';
import { billingReturnKind } from './lib/billing';
import { PlaybackModal } from './components/PlaybackModal';
import { type DiscoveryFilters, type ReleaseEra, type RuntimeFilter } from './lib/discovery';
import { composeDiscoverFeed } from './lib/feed';
import { imageUrl, scoreMatch, type MediaItem } from './lib/media';
import { useWatchProgress } from './components/WatchProgressProvider';
import { entryToMediaItem, type ProgressEntry } from './lib/watchProgress';
import { getPlaybackConfig, type PlaybackConfig } from './lib/playback';
import {
  initialSessionState,
  mediaKey,
  sanitizeSessionState,
  sessionReducer,
} from './lib/session';
import {
  createTmdbClient,
  type PreviewContext,
  type TitleContext,
  type TmdbClient,
} from './lib/tmdb';
import type { PartyPlaybackConfig } from './components/PartyPlaybackPlayer';
import type { WatchPartyService } from './lib/watchParty';

export interface AppProps {
  client?: TmdbClient;
  partyService?: WatchPartyService | null;
  playbackConfig?: PlaybackConfig;
  partyPlaybackConfig?: PartyPlaybackConfig;
  /* Omit for the app's own account layer; pass null to run with no backend. */
  accountService?: AccountService | null;
  /* Omit for the app's own billing client; pass null to run with no backend. */
  billingService?: BillingService | null;
  /* Omit for the app's own progress layer; pass null for device-local only. */
  watchProgressService?: WatchProgressService | null;
}

type View = 'discover' | 'friends' | 'vibe' | 'list';

const FriendsRoute = lazy(() =>
  import('./components/FriendsRoute').then((module) => ({ default: module.FriendsRoute })),
);

const defaultFilters: DiscoveryFilters = {
  contentType: 'both',
  genreIds: [],
  releaseEra: 'any',
  rating: null,
  runtime: 'any',
  sort: 'popularity',
};

const genres = [
  [28, 'Action'], [35, 'Comedy'], [27, 'Horror'], [53, 'Thriller'], [878, 'Sci-Fi'],
  [80, 'Crime'], [10749, 'Romance'], [14, 'Fantasy'], [16, 'Animation'], [99, 'Documentary'],
] as const;

const vibes = [
  { name: 'Dark', copy: 'Crime, horror, and beautiful unease.', ids: [27, 53, 80] },
  { name: 'Funny', copy: 'Sharp comedy and easy energy.', ids: [35] },
  { name: 'Chill', copy: 'Warm stories and low-stakes escape.', ids: [10749, 10751] },
  { name: 'Epic', copy: 'Big worlds, action, and adventure.', ids: [28, 12, 14] },
  { name: 'Mind-Bending', copy: 'Science fiction, mystery, and twists.', ids: [878, 9648, 53] },
] as const;

function loadSession() {
  try {
    const saved = sessionStorage.getItem('glocktv-session');
    if (!saved) return initialSessionState;
    return sanitizeSessionState(JSON.parse(saved));
  } catch {
    return initialSessionState;
  }
}

function Logo() {
  return (
    <div className="logo" aria-label="GlockTV">
      <span><Play fill="currentColor" /></span>
      <b>GLOCKTV</b>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="state-panel">
      <LoaderCircle className="spin" />
      <strong>Loading your feed</strong>
      <span>Finding something worth watching.</span>
    </div>
  );
}

/*
 * The account layer wraps the whole shell, so identity and entitlements are
 * owned here rather than fetched again by each feature that needs them.
 */
export function App({ accountService, watchProgressService, ...props }: AppProps) {
  return (
    /* Progress sits inside the account, not beside it: it re-syncs when the
       session changes, and a guest's device-local history is the same code
       path with no service under it. */
    <AccountProvider service={accountService}>
      <WatchProgressProvider service={watchProgressService}>
        <AppShell {...props} />
      </WatchProgressProvider>
    </AccountProvider>
  );
}

function AppShell({ client, partyService, playbackConfig, partyPlaybackConfig, billingService }: Omit<AppProps, 'accountService'>) {
  const api = useMemo(() => client ?? createTmdbClient({
    apiKey: import.meta.env.VITE_TMDB_API_KEY,
    readToken: import.meta.env.VITE_TMDB_READ_TOKEN,
  }), [client]);

  const playback = useMemo(() => playbackConfig ?? getPlaybackConfig(), [playbackConfig]);
  const initialRoomCode = useMemo(
    () => new URLSearchParams(window.location.search).get('room') ?? '',
    [],
  );

  const [items, setItems] = useState<MediaItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState(1);
  const [view, setView] = useState<View>(() => initialRoomCode ? 'friends' : 'discover');
  const [filters, setFilters] = useState(defaultFilters);
  const [draftFilters, setDraftFilters] = useState(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [context, setContext] = useState<TitleContext | null>(null);
  const [previewContext, setPreviewContext] = useState<PreviewContext | null>(null);
  const [modalMode, setModalMode] = useState<'details' | 'trailer' | 'channel' | null>(null);
  const [playbackItem, setPlaybackItem] = useState<MediaItem | null>(null);
  /*
   * Which episode the player should open on.
   *
   * Only ever set from a Continue Watching card, where the entry names a real
   * season and episode. Everywhere else this is null and the player opens
   * where it always has - a series at its first episode. Without it, resuming
   * a show you are four episodes into would drop you back at S1/E1 with the
   * right title and the wrong story.
   */
  const [playbackStart, setPlaybackStart] = useState<{ season: number; episode: number } | null>(null);

  const openPlayback = useCallback((item: MediaItem, entry?: ProgressEntry | null) => {
    setPlaybackStart(entry && entry.mediaType === 'tv'
      ? { season: entry.seasonNumber, episode: entry.episodeNumber }
      : null);
    setPlaybackItem(item);
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /*
   * My List has two things in it that are both "yours": what you saved, and
   * what you are partway through. They share a destination rather than taking
   * a sixth slot in a five-slot tab bar, and they render through the same card
   * feed so Continue Watching needs no second visual language.
   */
  const [listTab, setListTab] = useState<'saved' | 'continue'>('saved');
  /*
   * Stripe's hosted pages come back with a marker. It is a cue to re-ask the
   * server what this account is entitled to and nothing else - a member who
   * types this URL gets the same answer as one who paid.
   */
  const billingReturn = useMemo(() => billingReturnKind(window.location.search), []);
  const { confirmMembership } = useAccount();
  const billingReturnHandled = useRef(false);

  /*
   * Coming back from Stripe opens the account panel and starts the bounded
   * re-check. The marker is then removed from the URL so a refresh - or a
   * shared link - does not put the page back into a confirming state.
   */
  useEffect(() => {
    if (!billingReturn || billingReturnHandled.current) return;
    billingReturnHandled.current = true;
    setAccountOpen(true);
    void confirmMembership();

    const url = new URL(window.location.href);
    url.searchParams.delete('billing');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, [billingReturn, confirmMembership]);
  const [isMobileView, setIsMobileView] = useState(false);
  const [session, dispatch] = useReducer(sessionReducer, undefined, loadSession);

  const contextCache = useRef(new Map<string, TitleContext>());
  const contextRequests = useRef(new Map<string, Promise<TitleContext>>());
  const previewCache = useRef(new Map<string, PreviewContext>());
  const previewRequests = useRef(new Map<string, Promise<PreviewContext>>());
  const feedRequestVersion = useRef(0);
const modalContextVersion = useRef(0);
const touchStartY = useRef<number | null>(null);
const wheelLockedUntil = useRef(0);

  const loadTitleContext = useCallback((item: Pick<MediaItem, 'id' | 'mediaType'>) => {
    const key = mediaKey(item);
    const cached = contextCache.current.get(key);
    if (cached) return Promise.resolve(cached);

    const inFlight = contextRequests.current.get(key);
    if (inFlight) return inFlight;

    const pending = api.getTitleContext(item)
      .then((result) => {
        contextCache.current.set(key, result);
        contextRequests.current.delete(key);
        return result;
      })
      .catch((reason) => {
        contextRequests.current.delete(key);
        throw reason;
      });

    contextRequests.current.set(key, pending);
    return pending;
  }, [api]);

  const loadPreviewContext = useCallback((item: Pick<MediaItem, 'id' | 'mediaType'>) => {
    const key = mediaKey(item);
    const cached = previewCache.current.get(key);
    if (cached) return Promise.resolve(cached);

    const inFlight = previewRequests.current.get(key);
    if (inFlight) return inFlight;

    const pending: Promise<PreviewContext> = (
      api.getPreviewContext?.(item) ?? api.getTitleContext(item)
    )
      .then((result) => {
        const preview: PreviewContext = {
          details: result.details,
          trailer: result.trailer,
        };
        previewCache.current.set(key, preview);
        previewRequests.current.delete(key);
        return preview;
      })
      .catch((reason) => {
        previewRequests.current.delete(key);
        throw reason;
      });

    previewRequests.current.set(key, pending);
    return pending;
  }, [api]);

  useEffect(() => {
    try {
      sessionStorage.setItem('glocktv-session', JSON.stringify(session));
    } catch {
      // Session persistence is optional.
    }
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    const requestVersion = ++feedRequestVersion.current;

    setLoading(true);

    void api.getTrending()
      .then((results) => {
        if (cancelled || requestVersion !== feedRequestVersion.current) return;
        setItems(composeDiscoverFeed(results, {
  likedGenreIds: session.likedGenreIds,
  skippedGenreIds: session.skippedGenreIds,
  selectedGenreIds: filters.genreIds,
}));
        setError('');
      })
      .catch(() => {
        if (cancelled || requestVersion !== feedRequestVersion.current) return;
        setError('The feed could not load. Check the TMDB key and try again.');
      })
      .finally(() => {
        if (!cancelled && requestVersion === feedRequestVersion.current) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const watchProgress = useWatchProgress();

  /*
   * Continue Watching, as cards.
   *
   * A tile prefers a title this session already knows - the feed, or My List -
   * because that carries the overview, rating and genres a card shows. The
   * stored snapshot is the fallback, and it is what makes the surface work on
   * a device that has never loaded this title, or with no TMDB key at all.
   */
  const continueItems = useMemo(() => {
    const known = new Map<string, MediaItem>();
    for (const item of [...items, ...session.myList]) known.set(mediaKey(item), item);
    return watchProgress.continueWatching.map(
      (entry) => entryToMediaItem(entry, known.get(mediaKey({ id: entry.mediaId, mediaType: entry.mediaType }))),
    );
  }, [items, session.myList, watchProgress.continueWatching]);

  /*
   * Episodes share their series' id, so a card list keyed by media key would
   * collapse three episodes of one show into one card. The entry list stays
   * alongside, in the same order, and the card at an index is described by the
   * entry at that index.
   */
  const activeProgressEntry = view === 'list' && listTab === 'continue'
    ? watchProgress.continueWatching[activeIndex] ?? null
    : null;

  const currentItems = view === 'list'
    ? listTab === 'continue' ? continueItems : session.myList
    : items.filter((item) => !session.skippedKeys.includes(mediaKey(item)));

  useEffect(() => {
    setActiveIndex((index) => {
      if (!currentItems.length) return 0;
      return Math.min(index, currentItems.length - 1);
    });
  }, [currentItems.length]);

  useEffect(() => { setActiveIndex(0); }, [listTab]);

  const current = currentItems[Math.min(activeIndex, Math.max(0, currentItems.length - 1))];
  const saved = current
    ? session.myList.some((item) => mediaKey(item) === mediaKey(current))
    : false;

  const match = current ? scoreMatch(current, {
    selectedGenreIds: filters.genreIds,
    likedGenreIds: session.likedGenreIds,
    skippedGenreIds: session.skippedGenreIds,
  }) : 0;

  const previewTrailerKey = current && previewContext
    && previewContext.details.id === current.id
    && previewContext.details.mediaType === current.mediaType
    ? previewContext.trailer?.key ?? null
    : null;

  useEffect(() => {
    if (!current) {
      setPreviewContext(null);
      return;
    }

    const key = mediaKey(current);
    setPreviewContext(previewCache.current.get(key) ?? null);

    let cancelled = false;

    void loadPreviewContext(current)
      .then((result) => {
        if (cancelled) return;

        setPreviewContext(result);

        if (result.details.runtime !== null) {
          setItems((previous) => previous.map((item) => (
            mediaKey(item) === mediaKey(result.details)
              ? {
                  ...item,
                  runtime: result.details.runtime,
                  genres: result.details.genres.length
                    ? result.details.genres
                    : item.genres,
                }
              : item
          )));
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewContext(null);
      });

    return () => {
      cancelled = true;
    };
  }, [current?.id, current?.mediaType, loadPreviewContext]);

  const move = useCallback((direction: number) => {
    if (!currentItems.length) return;
    setSlideDirection(direction);
    setActiveIndex((index) => (index + direction + currentItems.length) % currentItems.length);
  }, [currentItems.length]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        modalMode
        || playbackItem
        || filtersOpen
        || vibeOpen
        || target?.tagName === 'INPUT'
        || target?.isContentEditable
      ) {
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        move(1);
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        move(-1);
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [filtersOpen, modalMode, move, playbackItem, vibeOpen]);

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    if (Math.abs(event.deltaY) < 25) return;
    const now = Date.now();
    if (now < wheelLockedUntil.current) return;
    wheelLockedUntil.current = now + 650;
    move(event.deltaY > 0 ? 1 : -1);
  };

  const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
    touchStartY.current = event.touches[0]?.clientY ?? null;
  };

  const handleTouchEnd = (event: TouchEvent<HTMLElement>) => {
    const start = touchStartY.current;
    const end = event.changedTouches[0]?.clientY;
    touchStartY.current = null;

    if (start === null || end === undefined) return;

    const distance = start - end;
    if (Math.abs(distance) < 55) return;
    move(distance > 0 ? 1 : -1);
  };

  const openContext = async (
  item: MediaItem,
  mode: 'details' | 'trailer' | 'channel',
) => {
  const requestVersion = ++modalContextVersion.current;

  setModalMode(mode);
  setContext(null);

  try {
    const nextContext = await loadTitleContext(item);

    if (requestVersion !== modalContextVersion.current) return;

    setContext(nextContext);
  } catch {
    if (requestVersion !== modalContextVersion.current) return;

    setError('Title details are temporarily unavailable.');
    setModalMode(null);
  }
};

  const loadDiscovery = useCallback(async (
    nextFilters: DiscoveryFilters,
    failureMessage = 'The feed could not be updated. Try again.',
  ) => {
    const requestVersion = ++feedRequestVersion.current;

    setFilters(nextFilters);
    setDraftFilters(nextFilters);
    setView('discover');
    setActiveIndex(0);
    setLoading(true);

    try {
      const results = await api.discover(nextFilters);

      if (requestVersion !== feedRequestVersion.current) return;

      setItems(composeDiscoverFeed(results, {
  likedGenreIds: session.likedGenreIds,
  skippedGenreIds: session.skippedGenreIds,
  selectedGenreIds: nextFilters.genreIds,
}));
      setError('');
    } catch {
      if (requestVersion === feedRequestVersion.current) {
        setError(failureMessage);
      }
    } finally {
      if (requestVersion === feedRequestVersion.current) {
        setLoading(false);
      }
    }
  }, [
  api,
  session.likedGenreIds,
  session.skippedGenreIds,
]);

  const applyFilters = () => {
    setFiltersOpen(false);
    void loadDiscovery(
      draftFilters,
      'Those filters could not be applied. Try again.',
    );
  };

  const chooseVibe = (genreIds: readonly number[]) => {
    const next: DiscoveryFilters = {
      ...filters,
      genreIds: [...genreIds],
      sort: 'popularity',
    };

    setVibeOpen(false);
    void loadDiscovery(next, 'That vibe is taking a break. Try another.');
  };

  /*
   * Debounce, request generations, the stale-term guard and the keyboard
   * contract are the shared controller's job; Discover only decides which of
   * its two search bars renders the popup.
   *
   * pickSuggestion is a hoisted declaration so it can close over the
   * controller it is handed to - it never runs before the hook returns.
   */
  const suggest = useMediaSearchSuggestions({
    term: query,
    search: api.search,
    onSelect: (item) => pickSuggestion(item),
  });

  const activeSuggestions = suggest.suggestions;
  const activeSuggestIndex = suggest.activeIndex;
  const suggestOpen = suggest.open;
  const suggestLoading = suggest.loading;
  const setSuggestIndex = suggest.setActiveIndex;
  const openSuggestions = suggest.openSuggestions;
  const resetSuggestions = suggest.reset;
  const onSearchKeyDown = suggest.onKeyDown;
  /* Exactly one bar owns the popup, decided by the breakpoint rather than by
     CSS visibility alone. */
  const desktopSuggestOwner = !(isMobileView && mobileSearchOpen);
  const desktopSuggestVisible = suggest.visible && desktopSuggestOwner;
  const mobileSuggestVisible = suggest.visible && !desktopSuggestOwner;

  /* Which UI owns the popup is a breakpoint fact, and CSS alone cannot tell
     React about it - leaving mobileSearchOpen set past a resize used to
     suppress the popup on the visible desktop box. */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 700px)');
    const sync = () => setIsMobileView(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!isMobileView && mobileSearchOpen) setMobileSearchOpen(false);
  }, [isMobileView, mobileSearchOpen]);

  /* Show the picked title first, with the rest of its matches behind it. */
  function pickSuggestion(picked: MediaItem) {
    const rest = activeSuggestions.filter(
      (item) => !(item.id === picked.id && item.mediaType === picked.mediaType),
    );

    feedRequestVersion.current += 1;
    setItems([picked, ...rest]);
    setActiveIndex(0);
    setView('discover');
    setError('');
    setLoading(false);
    setMobileSearchOpen(false);
    suggest.reset();
  }

  const search = async (event: FormEvent) => {
    event.preventDefault();
    // Cancels any scheduled autocomplete lookup, so submitting early costs
    // one request rather than two.
    resetSuggestions();

    const term = query.trim();
    if (!term) return;

    const requestVersion = ++feedRequestVersion.current;

    setLoading(true);
    setView('discover');
    setActiveIndex(0);

    try {
      const results = await api.search(term);

      if (requestVersion !== feedRequestVersion.current) return;

      const exactTitle = term.toLocaleLowerCase();
      setItems([...results].sort(
        (left, right) =>
          Number(right.title.toLocaleLowerCase() === exactTitle)
          - Number(left.title.toLocaleLowerCase() === exactTitle),
      ));

      setError('');
      setMobileSearchOpen(false);
    } catch {
      if (requestVersion === feedRequestVersion.current) {
        setError('Search is unavailable right now.');
      }
    } finally {
      if (requestVersion === feedRequestVersion.current) {
        setLoading(false);
      }
    }
  };

  const setNav = (next: View) => {
    if (next === 'vibe') {
      setVibeOpen(true);
      return;
    }

    setView(next);
    setActiveIndex(0);
  };

  const paginationStart = Math.max(
    0,
    Math.min(
      activeIndex - 3,
      Math.max(0, currentItems.length - 7),
    ),
  );

  const paginationItems = currentItems.slice(
    paginationStart,
    paginationStart + 7,
  );

  return (
    <div className={`app-shell ${view === 'friends' ? 'app-shell--friends' : ''}`}>
      <header className="topbar">
        <Logo />
        <nav className="topbar__nav" aria-label="Primary navigation">
          <button className={view === 'discover' ? 'active' : ''} onClick={() => setNav('discover')}>Discover</button>
          <button className={view === 'friends' ? 'active' : ''} onClick={() => setNav('friends')}>Friends</button>
          <button aria-label="Vibe" onClick={() => setNav('vibe')}>Vibe</button>
          <button aria-label="My List" className={view === 'list' ? 'active' : ''} onClick={() => setNav('list')}>My List</button>
        </nav>

        <form className="searchbar" onSubmit={search}>
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              suggest.setOpen(true);
            }}
            onFocus={openSuggestions}
            onBlur={() => suggest.setOpen(false)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search movies, shows, people..."
            aria-label="Search"
            role="combobox"
            aria-expanded={desktopSuggestVisible}
            aria-controls={desktopSuggestVisible ? 'search-suggestions-desktop' : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              desktopSuggestVisible && activeSuggestIndex >= 0
                ? optionId('search-suggestions-desktop', activeSuggestIndex)
                : undefined
            }
          />
          {/* The topbar is display:none on phones, but a hidden duplicate list
              still reaches assistive tech, so only one is ever mounted. */}
          {desktopSuggestOwner && suggestOpen && (
            <SearchSuggestions
              id="search-suggestions-desktop"
              items={activeSuggestions}
              loading={suggestLoading}
              activeIndex={activeSuggestIndex}
              onPick={pickSuggestion}
              onHover={setSuggestIndex}
            />
          )}
        </form>

        <button className="topbar__icon" aria-label="Notifications"><Bell size={18} /></button>
        <AccountButton onOpen={() => setAccountOpen(true)} />
      </header>

      <aside className={`sidebar ${view === 'friends' ? 'sidebar--hidden' : ''}`}>
        <p>Your feed</p>
        <nav>
          <button className={view === 'discover' ? 'active' : ''} onClick={() => setNav('discover')}>
            <Sparkles /> For You
          </button>

          <button
            onClick={() => {
              const next: DiscoveryFilters = { ...filters, sort: 'popularity' };
              void loadDiscovery(next, 'Trending titles could not be loaded.');
            }}
          >
            <Zap /> Trending
          </button>

          {/* Desktop only, by virtue of living in the sidebar. On a phone the
              same surface is the Continue Watching tab inside My List. */}
          {!!watchProgress.continueWatching.length && (
            <button
              className={view === 'list' && listTab === 'continue' ? 'active' : ''}
              onClick={() => {
                setListTab('continue');
                setNav('list');
              }}
            >
              <History /> Continue Watching
            </button>
          )}

          <button
            onClick={() => {
              const next: DiscoveryFilters = {
                ...filters,
                releaseEra: 'new',
                sort: 'newest',
              };
              void loadDiscovery(next, 'New releases could not be loaded.');
            }}
          >
            <Star /> New Releases
          </button>
        </nav>

        <p>Genres</p>
        <nav className="genre-nav">
          <button className={!filters.genreIds.length ? 'active' : ''} onClick={() => chooseVibe([])}>
            <Film /> All
          </button>
          {genres.slice(0, 8).map(([id, name]) => (
            <button
              key={id}
              className={filters.genreIds.includes(id) ? 'active' : ''}
              onClick={() => chooseVibe([id])}
            >
              <span className="genre-dot" />
              {name}
            </button>
          ))}
        </nav>

        <button
          className="filter-button"
          aria-label="Open filters"
          onClick={() => {
            setDraftFilters(filters);
            setFiltersOpen(true);
          }}
        >
          <SlidersHorizontal /> Filter
        </button>
      </aside>

      <main
        className={view === 'friends' ? 'friends-stage' : 'feed-stage'}
        onWheel={view === 'friends' ? undefined : handleWheel}
        onTouchStart={view === 'friends' ? undefined : handleTouchStart}
        onTouchEnd={view === 'friends' ? undefined : handleTouchEnd}
      >
        {view === 'friends' ? (
          <Suspense
            fallback={
              <div className="state-panel">
                <LoaderCircle className="spin" />
                <strong>Opening Friends</strong>
                <span>Getting the room ready.</span>
              </div>
            }
          >
            <FriendsRoute
              client={api}
              service={partyService}
              selectedTitle={current ?? null}
              trailerKey={previewTrailerKey}
              initialRoomCode={initialRoomCode}
              partyPlaybackConfig={partyPlaybackConfig}
            />
          </Suspense>
        ) : (
          <>
            <div className={`mobile-tabs ${mobileSearchOpen ? 'mobile-tabs--search' : ''}`}>
              {mobileSearchOpen ? (
                <form className="mobile-searchbar" role="search" onSubmit={search}>
                  <Search aria-hidden="true" />
                  <input
                    autoFocus
                    type="search"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      suggest.setOpen(true);
                    }}
                    onFocus={openSuggestions}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Search titles..."
                    aria-label="Search movies and TV shows"
                    role="combobox"
                    aria-expanded={mobileSuggestVisible}
                    aria-controls={mobileSuggestVisible ? 'search-suggestions-mobile' : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      mobileSuggestVisible && activeSuggestIndex >= 0
                        ? optionId('search-suggestions-mobile', activeSuggestIndex)
                        : undefined
                    }
                  />
                  <button type="submit" aria-label="Run search"><Search /></button>
                  <button
                    type="button"
                    aria-label="Close search"
                    onClick={() => {
                      resetSuggestions();
                      setMobileSearchOpen(false);
                    }}
                  >
                    <X />
                  </button>
                  {!desktopSuggestOwner && suggestOpen && (
                    <SearchSuggestions
                      id="search-suggestions-mobile"
                      items={activeSuggestions}
                      loading={suggestLoading}
                      activeIndex={activeSuggestIndex}
                      onPick={pickSuggestion}
                      onHover={setSuggestIndex}
                    />
                  )}
                </form>
              ) : (
                <>
                  {(['both', 'movies', 'tv'] as const).map((type) => (
                    <button
                      key={type}
                      className={filters.contentType === type ? 'active' : ''}
                      onClick={() => {
                        const next: DiscoveryFilters = { ...filters, contentType: type };
                        void loadDiscovery(next);
                      }}
                    >
                      {type === 'both' ? 'All' : type === 'tv' ? 'TV Shows' : 'Movies'}
                    </button>
                  ))}
                  <button aria-label="Search titles" onClick={() => setMobileSearchOpen(true)}>
                    <Search />
                  </button>
                  <button
                    aria-label="Open mobile filters"
                    onClick={() => {
                      setDraftFilters(filters);
                      setFiltersOpen(true);
                    }}
                  >
                    <Filter />
                  </button>
                  {/* The topbar is hidden on phones, so the account lives with
                      the other top controls rather than taking a tab-bar slot
                      from a product destination. */}
                  <MobileAccountButton onOpen={() => setAccountOpen(true)} />
                </>
              )}
            </div>

            {view === 'list' && (
              <div className="view-title">
                <span>{listTab === 'continue' ? 'Pick up where you left off' : 'Saved for this session'}</span>
                <h2>{listTab === 'continue' ? 'Continue Watching' : 'Your List'}</h2>
                <div className="view-tabs" role="tablist" aria-label="My List sections">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={listTab === 'saved'}
                    className={listTab === 'saved' ? 'active' : ''}
                    onClick={() => setListTab('saved')}
                  >
                    My List
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={listTab === 'continue'}
                    className={listTab === 'continue' ? 'active' : ''}
                    onClick={() => setListTab('continue')}
                  >
                    Continue Watching
                    {!!watchProgress.continueWatching.length && (
                      <i>{watchProgress.continueWatching.length}</i>
                    )}
                  </button>
                </div>
              </div>
            )}

            {error && <div className="notice" role="alert">{error}</div>}

            {loading ? (
              <LoadingState />
            ) : current ? (
              <motion.div
                key={mediaKey(current)}
                initial={{ opacity: 0, y: slideDirection * 90, scale: .985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ duration: .32, ease: 'easeOut' }}
              >
                <MediaCard
                  item={current}
                  match={match}
                  saved={saved}
                  progress={activeProgressEntry}
                  onForgetProgress={activeProgressEntry
                    ? () => { void watchProgress.forgetProgress(activeProgressEntry); }
                    : undefined}
                  trailerKey={previewTrailerKey}
                  onToggleList={(item) => dispatch({ type: 'toggle-list', item })}
                  onWatch={(chosen) => openPlayback(chosen, activeProgressEntry)}
                  onDetails={(item) => void openContext(item, 'details')}
                  onTrailer={(item) => void openContext(item, 'trailer')}
                  onLike={(item) => {
                    dispatch({ type: 'like', item });
                    move(1);
                  }}
                  onSkip={(item) => {
                    dispatch({ type: 'skip', item });
                  }}
                />
              </motion.div>
            ) : (
              <div className="state-panel">
                <Bookmark />
                <strong>{
                  view !== 'list'
                    ? 'No matches yet'
                    : listTab === 'continue'
                      ? 'Nothing in progress'
                      : 'Your list is empty'
                }</strong>
                <span>
                  {view !== 'list'
                    ? 'Try clearing a few filters.'
                    : listTab === 'continue'
                      /* Honest about the limit: position comes from the player,
                         and not every provider reports one. */
                      ? 'Start something and leave partway through. Titles appear here once a player reports where you got to.'
                      : 'Save a title from Discover and it will appear here.'}
                </span>
              </div>
            )}

            {!!currentItems.length && (
              <div className="feed-pagination">
                <button aria-label="Previous title" onClick={() => move(-1)}><ChevronUp /></button>
                <div>
                  {paginationItems.map((item, index) => (
                    <span
                      key={mediaKey(item)}
                      className={paginationStart + index === activeIndex ? 'active' : ''}
                    />
                  ))}
                </div>
                <button aria-label="Next title" onClick={() => move(1)}><ChevronDown /></button>
                <small>Scroll, swipe, or use ↑ ↓</small>
              </div>
            )}
          </>
        )}
      </main>

      <aside className={`context-panel ${view === 'friends' ? 'context-panel--hidden' : ''}`}>
        <section>
          <p>Why this?</p>
          <strong>
            {session.likedGenreIds.length
              ? 'Your session leans toward'
              : 'Popular with viewers who like'}
          </strong>
          <h3>{current?.genres.slice(0, 2).join(' + ') || 'bold storytelling'}</h3>
        </section>

        <section>
          <p>Top genres</p>
          <div className="chips">
            {(current?.genres ?? ['Crime', 'Thriller', 'Drama']).slice(0, 3).map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
        </section>

        <section className="similar">
          <p>Similar vibes</p>
          {currentItems.slice(activeIndex + 1, activeIndex + 4).map((item) => {
            const poster = imageUrl(item.posterPath, 'w185');
            return (
              <button
                key={mediaKey(item)}
                onClick={() => setActiveIndex(currentItems.indexOf(item))}
              >
                {poster && <img src={poster} alt="" loading="lazy" />}
                <span>
                  <b>{item.title}</b>
                  <small>{item.year} · ★ {item.rating.toFixed(1)}</small>
                </span>
              </button>
            );
          })}
        </section>

        <section className="channel-card">
          <Users />
          <h3>Watch with friends</h3>
          <p>Open a private movie night or meet new people in the public lounge.</p>
          <button aria-label="Open Friends" onClick={() => setNav('friends')}>
            <Users /> Watch together
          </button>
        </section>

        {/* Last in the column, so nothing about the product moves to make room
            for it and a Premium member's layout is identical without it. */}
        <AdSlot placement="context-rail" />
      </aside>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <button className={view === 'discover' ? 'active' : ''} onClick={() => setNav('discover')}>
          <Compass /><span>Discover</span>
        </button>
        <button className={view === 'friends' ? 'active' : ''} onClick={() => setNav('friends')}>
          <Users /><span>Friends</span>
        </button>
        <button aria-label="Mobile Vibe" onClick={() => setNav('vibe')}>
          <Sparkles /><span>Vibe</span>
        </button>
        <button
          aria-label="Mobile My List"
          className={view === 'list' ? 'active' : ''}
          onClick={() => setNav('list')}
        >
          <Bookmark /><span>My List</span>
        </button>
        {/* Live TV portals its button in here as the fifth destination. */}
      </nav>

      <AnimatePresence>
        {filtersOpen && (
          <FilterPanel
            filters={draftFilters}
            onChange={setDraftFilters}
            onClose={() => setFiltersOpen(false)}
            onApply={applyFilters}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {vibeOpen && (
          <VibePanel
            onClose={() => setVibeOpen(false)}
            onChoose={chooseVibe}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {modalMode && (
          <TitleModal
            mode={modalMode}
            context={context}
            onClose={() => {
              setModalMode(null);
              setContext(null);
            }}
            onNext={() => {
              setModalMode(null);
              setContext(null);
              move(1);
              setTimeout(() => {
                const next = currentItems[(activeIndex + 1) % currentItems.length];
                if (next) void openContext(next, 'channel');
              }, 0);
            }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {playbackItem && (
          <PlaybackModal
            item={playbackItem}
            initialSeason={playbackStart?.season}
            initialEpisode={playbackStart?.episode}
            config={playback}
            client={api}
            onClose={() => { setPlaybackItem(null); setPlaybackStart(null); }}
            /* A recommendation is a different title, so it starts fresh. */
            onSelect={(next) => openPlayback(next)}
          />
        )}
      </AnimatePresence>

      {accountOpen && <AccountPanel onClose={() => setAccountOpen(false)} billing={billingService} />}

      <footer className="credits">
        Movie and TV data supplied by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Watch availability powered by JustWatch.
      </footer>
    </div>
  );
}

/*
 * The account entry point. It says what the account is at a glance - a guest
 * initial, an email initial, or the Premium mark - and opens the one account
 * surface.
 */
function AccountButton({ onOpen }: { onOpen: () => void }) {
  const { account, entitlements } = useAccount();
  const isGuest = !account || account.isAnonymous;
  const isPremium = entitlements.tier === 'premium';
  const initial = account?.email?.trim()?.[0]?.toUpperCase() ?? 'G';

  return (
    <button
      type="button"
      className="avatar topbar__account"
      aria-label={
        isPremium
          ? 'Your account, Premium'
          : isGuest ? 'Your account, guest' : `Your account, ${account?.email}`
      }
      onClick={onOpen}
    >
      {isPremium ? <Sparkles size={15} /> : initial}
    </button>
  );
}

/*
 * The account, as a header control on phones.
 *
 * A guest gets the invitation spelled out - "Sign up" next to the avatar -
 * because a bare avatar tells somebody with no account nothing. Once there is
 * an account the label drops away and it becomes the avatar alone, so the
 * header stays balanced against All / Movies / TV Shows / Search / Filter.
 */
function MobileAccountButton({ onOpen }: { onOpen: () => void }) {
  const { account, entitlements } = useAccount();
  const isPremium = entitlements.tier === 'premium';
  const isGuest = !account || account.isAnonymous;
  const initial = account?.email?.trim()?.[0]?.toUpperCase() ?? '';

  return (
    <button
      type="button"
      className={`mobile-account${isGuest ? ' mobile-account--guest' : ''}${isPremium ? ' mobile-account--premium' : ''}`}
      aria-label={
        isPremium
          ? 'Your account, Premium'
          : isGuest ? 'Your account, guest' : `Your account, ${account?.email}`
      }
      onClick={onOpen}
    >
      <span className="mobile-account__mark" aria-hidden="true">
        {isPremium ? <Sparkles /> : isGuest ? <CircleUser /> : initial}
      </span>
      {isGuest && <span className="mobile-account__label">Sign up</span>}
    </button>
  );
}

function FilterPanel({
  filters,
  onChange,
  onClose,
  onApply,
}: {
  filters: DiscoveryFilters;
  onChange: (next: DiscoveryFilters) => void;
  onClose: () => void;
  onApply: () => void;
}) {
  const toggleGenre = (id: number) => onChange({
    ...filters,
    genreIds: filters.genreIds.includes(id)
      ? filters.genreIds.filter((genre) => genre !== id)
      : [...filters.genreIds, id],
  });

  /* A drawer over a full-page scrim behaves as a modal, so it gets the trap. */
  const dialog = useDialogBehavior<HTMLElement>({ onClose });

  return (
    <motion.div
      className="overlay overlay--right"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.aside
        ref={dialog}
        className="filter-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Filter your feed"
        initial={{ x: 80 }}
        animate={{ x: 0 }}
        exit={{ x: 80 }}
      >
        <header>
          <div><Filter /><h2>Filter your feed</h2></div>
          <button aria-label="Close filters" onClick={onClose}><X /></button>
        </header>

        <FilterGroup title="Content">
          {(['movies', 'tv', 'both'] as const).map((type) => (
            <button
              key={type}
              className={filters.contentType === type ? 'active' : ''}
              onClick={() => onChange({ ...filters, contentType: type })}
            >
              {type === 'tv' ? 'TV Shows' : type[0].toUpperCase() + type.slice(1)}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Genres">
          {genres.map(([id, name]) => (
            <button
              key={id}
              className={filters.genreIds.includes(id) ? 'active' : ''}
              onClick={() => toggleGenre(id)}
            >
              {name}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Release year">
          {([
            ['new', 'New'],
            ['2020s', '2020s'],
            ['2010s', '2010s'],
            ['2000s', '2000s'],
            ['90s', '90s'],
            ['classics', 'Classics'],
          ] as [ReleaseEra, string][]).map(([value, label]) => (
            <button
              key={value}
              className={filters.releaseEra === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, releaseEra: value })}
            >
              {label}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Rating">
          {[null, 7, 8, 9].map((value) => (
            <button
              key={String(value)}
              className={filters.rating === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, rating: value })}
            >
              {value ? `${value}+` : 'Any'}
            </button>
          ))}
        </FilterGroup>

        <FilterGroup title="Runtime">
          {([
            ['any', 'Any'],
            ['under-90', '< 90m'],
            ['90-120', '90–120m'],
            ['over-120', '2h+'],
          ] as [RuntimeFilter, string][]).map(([value, label]) => (
            <button
              key={value}
              className={filters.runtime === value ? 'active' : ''}
              onClick={() => onChange({ ...filters, runtime: value })}
            >
              {label}
            </button>
          ))}
        </FilterGroup>

        <button className="apply-button" onClick={onApply}>
          Apply filters <SlidersHorizontal />
        </button>
        <button className="clear-button" onClick={() => onChange(defaultFilters)}>
          Clear all
        </button>
      </motion.aside>
    </motion.div>
  );
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="filter-group">
      <p>{title}</p>
      <div>{children}</div>
    </section>
  );
}

function VibePanel({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (ids: readonly number[]) => void;
}) {
  const dialog = useDialogBehavior<HTMLDivElement>({ onClose });

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* The dialog is the panel, not the scrim behind it: aria-modal and the
          accessible name belong on the thing the user is actually in. */}
      <motion.div
        ref={dialog}
        className="vibe-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a vibe"
        initial={{ y: 30, scale: .96 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 20, scale: .97 }}
      >
        <button className="modal-close" aria-label="Close vibe picker" onClick={onClose}>
          <X />
        </button>
        <Sparkles className="vibe-icon" />
        <span>Vibe mode</span>
        <h2>What are you in the mood for?</h2>
        <p>Pick a feeling. We’ll tune the feed around it.</p>
        <div>
          {vibes.map((vibe) => (
            <button key={vibe.name} aria-label={vibe.name} onClick={() => onChoose(vibe.ids)}>
              <b>{vibe.name}</b>
              <span>{vibe.copy}</span>
              <ChevronRight />
            </button>
          ))}
        </div>
      </motion.div>
    </motion.div>
  );
}

function TitleModal({
  mode,
  context,
  onClose,
  onNext,
}: {
  mode: 'details' | 'trailer' | 'channel';
  context: TitleContext | null;
  onClose: () => void;
  onNext: () => void;
}) {
  const providers = context?.providers
    ? [
        ...(context.providers.flatrate ?? []),
        ...(context.providers.free ?? []),
        ...(context.providers.ads ?? []),
        ...(context.providers.rent ?? []),
      ].filter(
        (provider, index, all) =>
          all.findIndex((item) => item.provider_id === provider.provider_id) === index,
      )
    : [];

  const dialog = useDialogBehavior<HTMLDivElement>({ onClose });

  return (
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        ref={dialog}
        className={`title-modal ${mode === 'channel' ? 'title-modal--channel' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={
          mode === 'channel'
            ? 'Channel player'
            : mode === 'trailer'
              ? 'Trailer player'
              : 'Title details'
        }
        initial={{ y: 30, scale: .97 }}
        animate={{ y: 0, scale: 1 }}
        exit={{ y: 20, scale: .98 }}
      >
        <button className="modal-close" aria-label="Close player" onClick={onClose}>
          <X />
        </button>

        {!context ? (
          <LoadingState />
        ) : (
          <>
            {mode !== 'details' && context.trailer ? (
              <div className="video-frame">
                <iframe
                  title={`${context.details.title} trailer`}
                  src={`https://www.youtube-nocookie.com/embed/${context.trailer.key}?autoplay=1&playsinline=1&rel=0`}
                  allow="autoplay; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              </div>
            ) : mode !== 'details' ? (
              <div className="video-missing">
                <Clapperboard />
                <p>No official trailer is available for this title.</p>
              </div>
            ) : null}

            <div className="title-modal__body">
              <span>
                {mode === 'channel'
                  ? 'Now playing'
                  : context.details.mediaType === 'movie'
                    ? 'Movie'
                    : 'Series'}
              </span>
              <h2>{context.details.title}</h2>
              <p>{context.details.overview}</p>

              <div className="provider-list">
                {providers.length ? (
                  providers.slice(0, 6).map((provider) => {
                    const logo = imageUrl(provider.logo_path, 'w92');
                    return (
                      <span key={provider.provider_id}>
                        {logo && <img src={logo} alt="" />}
                        {provider.provider_name}
                      </span>
                    );
                  })
                ) : (
                  <small>No US streaming provider is currently listed.</small>
                )}
              </div>

              <div className="modal-actions">
                {context.providerLink && (
                  <a href={context.providerLink} target="_blank" rel="noreferrer">
                    <Play fill="currentColor" /> See where to watch
                  </a>
                )}
                {mode === 'channel' && (
                  <button onClick={onNext}>
                    Next trailer <ChevronRight />
                  </button>
                )}
              </div>

              {!!providers.length && <small>Streaming availability powered by JustWatch.</small>}

              {/* Below everything the viewer opened this panel for. Never over
                  the trailer, never over the actions. */}
              <AdSlot placement="details-panel" />
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
