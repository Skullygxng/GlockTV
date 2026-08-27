import { FormEvent, lazy, Suspense, type TouchEvent, type WheelEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell, Bookmark, ChevronDown, ChevronRight, ChevronUp, Clapperboard,
  Compass, Film, Filter, Heart, ListVideo, LoaderCircle, Play, Search,
  SlidersHorizontal, Sparkles, Star, Users, X, Zap,
} from 'lucide-react';
import { MediaCard } from './components/MediaCard';
import { PlaybackModal } from './components/PlaybackModal';
import { type DiscoveryFilters, type ReleaseEra, type RuntimeFilter } from './lib/discovery';
import { imageUrl, scoreMatch, type MediaItem } from './lib/media';
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
} from './lib/tmdb';import type { PartyPlaybackConfig } from './components/PartyPlaybackPlayer';
import type { WatchPartyService } from './lib/watchParty';

export interface AppProps { client?: TmdbClient; partyService?: WatchPartyService | null; playbackConfig?: PlaybackConfig; partyPlaybackConfig?: PartyPlaybackConfig }

type View = 'discover' | 'friends' | 'vibe' | 'list';
const FriendsRoute = lazy(() => import('./components/FriendsRoute').then((module) => ({ default: module.FriendsRoute })));


const defaultFilters: DiscoveryFilters = {
  contentType: 'both', genreIds: [], releaseEra: 'any', rating: null, runtime: 'any', sort: 'popularity',
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
    return saved ? { ...initialSessionState, ...JSON.parse(saved) } : initialSessionState;
  } catch { return initialSessionState; }
}

function Logo() {
  return <div className="logo" aria-label="GlockTV"><span><Play fill="currentColor" /></span><b>GLOCKTV</b></div>;
}

function LoadingState() {
  return <div className="state-panel"><LoaderCircle className="spin" /><strong>Loading your feed</strong><span>Finding something worth watching.</span></div>;
}

export function App({ client, partyService, playbackConfig, partyPlaybackConfig }: AppProps) {
  const api = useMemo(() => client ?? createTmdbClient({
    apiKey: import.meta.env.VITE_TMDB_API_KEY,
    readToken: import.meta.env.VITE_TMDB_READ_TOKEN,
  }), [client]);
  const playback = useMemo(() => playbackConfig ?? getPlaybackConfig(), [playbackConfig]);
  const initialRoomCode = useMemo(() => new URLSearchParams(window.location.search).get('room') ?? '', []);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [slideDirection, setSlideDirection] = useState(1);
  const [view, setView] = useState<View>(() => initialRoomCode ? 'friends' : 'discover');
  const [filters, setFilters] = useState(defaultFilters);
  const [draftFilters, setDraftFilters] = useState(defaultFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [context, setContext] = useState<TitleContext | null>(null);
  const [previewContext, setPreviewContext] = useState<TitleContext | null>(null);
  const [modalMode, setModalMode] = useState<'details' | 'trailer' | 'channel' | null>(null);
  const [playbackItem, setPlaybackItem] = useState<MediaItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [session, dispatch] = useReducer(sessionReducer, undefined, loadSession);

  const contextCache = useRef(new Map<string, TitleContext>());
  const contextRequests = useRef(new Map<string, Promise<TitleContext>>());
  const touchStartY = useRef<number | null>(null);
  const wheelLockedUntil = useRef(0);

  const loadTitleContext = useCallback((item: Pick<MediaItem, 'id' | 'mediaType'>) => {
    const key = `${item.mediaType}:${item.id}`;
    const cached = contextCache.current.get(key);
    if (cached) return Promise.resolve(cached);
    const inFlight = contextRequests.current.get(key);
    if (inFlight) return inFlight;
    const pending = api.getTitleContext(item).then((result) => {
      contextCache.current.set(key, result);
      contextRequests.current.delete(key);
      return result;
    }).catch((reason) => {
      contextRequests.current.delete(key);
      throw reason;
    });
    contextRequests.current.set(key, pending);
    return pending;
  }, [api]);

  useEffect(() => { sessionStorage.setItem('glocktv-session', JSON.stringify(session)); }, [session]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getTrending().then((results) => {
      if (!cancelled) { setItems(results); setError(''); }
    }).catch(() => {
      if (!cancelled) setError('The feed could not load. Check the TMDB key and try again.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api]);

  const currentItems = view === 'list' ? session.myList : items.filter((item) => !session.skippedIds.includes(item.id));
  const current = currentItems[Math.min(activeIndex, Math.max(0, currentItems.length - 1))];
  const saved = current ? session.myList.some((item) => item.id === current.id && item.mediaType === current.mediaType) : false;
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
    if (!current || current.runtime !== null || view === 'list') return;

    let cancelled = false;
    loadTitleContext(current).then(({ details }) => {
      if (cancelled || details.runtime === null) return;
      setItems((previous) => previous.map((item) => (
        item.id === details.id && item.mediaType === details.mediaType
          ? {
              ...item,
              runtime: details.runtime,
              genres: details.genres.length ? details.genres : item.genres,
            }
          : item
      )));
    }).catch(() => undefined);

    return () => { cancelled = true; };
  }, [current?.id, current?.mediaType, current?.runtime, loadTitleContext, view]);

  useEffect(() => {
    if (!current) {
      setPreviewContext(null);
      return;
    }
    const cacheKey = `${current.mediaType}:${current.id}`;
    setPreviewContext(contextCache.current.get(cacheKey) ?? null);
    let cancelled = false;
    loadTitleContext(current).then((result) => {
      if (!cancelled) setPreviewContext(result);
    }).catch(() => { if (!cancelled) setPreviewContext(null); });
    return () => { cancelled = true; };
  }, [current?.id, current?.mediaType, loadTitleContext]);



  const move = useCallback((direction: number) => {
    if (!currentItems.length) return;
    setSlideDirection(direction);
    setActiveIndex((index) => (index + direction + currentItems.length) % currentItems.length);
  }, [currentItems.length]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (modalMode || playbackItem || filtersOpen || vibeOpen || target?.tagName === 'INPUT' || target?.isContentEditable) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
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


  const openContext = async (item: MediaItem, mode: 'details' | 'trailer' | 'channel') => {
    setModalMode(mode);
    setContext(null);
    try { setContext(await loadTitleContext(item)); }
    catch { setError('Title details are temporarily unavailable.'); setModalMode(null); }
  };

  const applyFilters = async () => {
    setFiltersOpen(false); setFilters(draftFilters); setLoading(true); setView('discover'); setActiveIndex(0);
    try { setItems(await api.discover(draftFilters)); setError(''); }
    catch { setError('Those filters could not be applied. Try again.'); }
    finally { setLoading(false); }
  };

  const chooseVibe = async (genreIds: readonly number[]) => {
    const next = { ...filters, genreIds: [...genreIds], sort: 'popularity' as const };
    setFilters(next); setDraftFilters(next); setVibeOpen(false); setView('discover'); setLoading(true); setActiveIndex(0);
    try { setItems(await api.discover(next)); setError(''); }
    catch { setError('That vibe is taking a break. Try another.'); }
    finally { setLoading(false); }
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const term = query.trim();
    if (!term) return;
    setLoading(true); setView('discover'); setActiveIndex(0);
    try {
      const results = await api.search(term);
      const exactTitle = term.toLocaleLowerCase();
      setItems([...results].sort((left, right) => Number(right.title.toLocaleLowerCase() === exactTitle) - Number(left.title.toLocaleLowerCase() === exactTitle)));
      setError(''); setMobileSearchOpen(false);
    }
    catch { setError('Search is unavailable right now.'); }
    finally { setLoading(false); }
  };

  const setNav = (next: View) => {
    if (next === 'vibe') { setVibeOpen(true); return; }
    setView(next); setActiveIndex(0);
  };

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
          <Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search movies, shows, people..." aria-label="Search" />
        </form>
        <button className="topbar__icon" aria-label="Notifications"><Bell size={18} /></button>
        <div className="avatar">G</div>
      </header>

      <aside className={`sidebar ${view === 'friends' ? 'sidebar--hidden' : ''}`}>
        <p>Your feed</p>
        <nav>
          <button className={view === 'discover' ? 'active' : ''} onClick={() => setNav('discover')}><Sparkles /> For You</button>
          <button onClick={() => { const next = { ...filters, sort: 'popularity' as const }; setDraftFilters(next); void applyFilters(); }}><Zap /> Trending</button>
          <button onClick={() => { const next = { ...filters, releaseEra: 'new' as const, sort: 'newest' as const }; setDraftFilters(next); void api.discover(next).then(setItems); }}><Star /> New Releases</button>
        </nav>
        <p>Genres</p>
        <nav className="genre-nav">
          <button className={!filters.genreIds.length ? 'active' : ''} onClick={() => void chooseVibe([])}><Film /> All</button>
          {genres.slice(0, 8).map(([id, name]) => <button key={id} className={filters.genreIds.includes(id) ? 'active' : ''} onClick={() => void chooseVibe([id])}><span className="genre-dot" />{name}</button>)}
        </nav>
        <button className="filter-button" aria-label="Open filters" onClick={() => { setDraftFilters(filters); setFiltersOpen(true); }}><SlidersHorizontal /> Filter</button>
      </aside>

      <main className={view === 'friends' ? 'friends-stage' : 'feed-stage'} onWheel={view === 'friends' ? undefined : handleWheel} onTouchStart={view === 'friends' ? undefined : handleTouchStart} onTouchEnd={view === 'friends' ? undefined : handleTouchEnd}>
        {view === 'friends' ? <Suspense fallback={<div className="state-panel"><LoaderCircle className="spin" /><strong>Opening Friends</strong><span>Getting the room ready.</span></div>}><FriendsRoute client={api} service={partyService} selectedTitle={current ?? null} trailerKey={previewTrailerKey} initialRoomCode={initialRoomCode} partyPlaybackConfig={partyPlaybackConfig} /></Suspense> : <>
        <div className={`mobile-tabs ${mobileSearchOpen ? 'mobile-tabs--search' : ''}`}>
          {mobileSearchOpen ? <form className="mobile-searchbar" role="search" onSubmit={search}>
            <Search aria-hidden="true" />
            <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles..." aria-label="Search movies and TV shows" />
            <button type="submit" aria-label="Run search"><Search /></button>
            <button type="button" aria-label="Close search" onClick={() => setMobileSearchOpen(false)}><X /></button>
          </form> : <>
            {(['both', 'movies', 'tv'] as const).map((type) => <button key={type} className={filters.contentType === type ? 'active' : ''} onClick={() => { const next = { ...filters, contentType: type }; setDraftFilters(next); setFilters(next); void api.discover(next).then(setItems); }}>{type === 'both' ? 'All' : type === 'tv' ? 'TV Shows' : 'Movies'}</button>)}
            <button aria-label="Search titles" onClick={() => setMobileSearchOpen(true)}><Search /></button>
            <button aria-label="Open mobile filters" onClick={() => { setDraftFilters(filters); setFiltersOpen(true); }}><Filter /></button>
          </>}
        </div>
        {view === 'list' && <div className="view-title"><span>Saved for this session</span><h2>Your List</h2></div>}
        {error && <div className="notice" role="alert">{error}</div>}
        {loading ? <LoadingState /> : current ? (
          <motion.div key={`${current.mediaType}-${current.id}`} initial={{ opacity: 0, y: slideDirection * 90, scale: .985 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: .32, ease: 'easeOut' }}>
            <MediaCard item={current} match={match} saved={saved}
              trailerKey={previewTrailerKey}
              onToggleList={(item) => dispatch({ type: 'toggle-list', item })}
              onWatch={setPlaybackItem}
              onDetails={(item) => void openContext(item, 'details')}
              onTrailer={(item) => void openContext(item, 'trailer')}
              onLike={(item) => { dispatch({ type: 'like', item }); move(1); }}
              onSkip={(item) => { dispatch({ type: 'skip', item }); move(1); }} />
          </motion.div>
        ) : <div className="state-panel"><Bookmark /><strong>{view === 'list' ? 'Your list is empty' : 'No matches yet'}</strong><span>{view === 'list' ? 'Save a title from Discover and it will appear here.' : 'Try clearing a few filters.'}</span></div>}
        {!!currentItems.length && <div className="feed-pagination"><button aria-label="Previous title" onClick={() => move(-1)}><ChevronUp /></button><div>{currentItems.slice(0, 7).map((item, index) => <span key={`${item.mediaType}-${item.id}`} className={index === activeIndex ? 'active' : ''} />)}</div><button aria-label="Next title" onClick={() => move(1)}><ChevronDown /></button><small>Scroll, swipe, or use ↑ ↓</small></div>}
        </>}
      </main>

      <aside className={`context-panel ${view === 'friends' ? 'context-panel--hidden' : ''}`}>
        <section><p>Why this?</p><strong>{session.likedGenreIds.length ? 'Your session leans toward' : 'Popular with viewers who like'}</strong><h3>{current?.genres.slice(0, 2).join(' + ') || 'bold storytelling'}</h3></section>
        <section><p>Top genres</p><div className="chips">{(current?.genres ?? ['Crime', 'Thriller', 'Drama']).slice(0, 3).map((genre) => <span key={genre}>{genre}</span>)}</div></section>
        <section className="similar"><p>Similar vibes</p>{currentItems.slice(activeIndex + 1, activeIndex + 4).map((item) => <button key={`${item.mediaType}-${item.id}`} onClick={() => setActiveIndex(currentItems.indexOf(item))}>{imageUrl(item.posterPath, 'w185') && <img src={imageUrl(item.posterPath, 'w185')!} alt="" />}<span><b>{item.title}</b><small>{item.year} · ★ {item.rating.toFixed(1)}</small></span></button>)}</section>
        <section className="channel-card"><Users /><h3>Watch with friends</h3><p>Open a private movie night or meet new people in the public lounge.</p><button aria-label="Open Friends" onClick={() => setNav('friends')}><Users /> Watch together</button></section>
      </aside>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <button className={view === 'discover' ? 'active' : ''} onClick={() => setNav('discover')}><Compass /><span>Discover</span></button>
        <button className={view === 'friends' ? 'active' : ''} onClick={() => setNav('friends')}><Users /><span>Friends</span></button>
        <button aria-label="Mobile Vibe" onClick={() => setNav('vibe')}><Sparkles /><span>Vibe</span></button>
        <button aria-label="Mobile My List" className={view === 'list' ? 'active' : ''} onClick={() => setNav('list')}><Bookmark /><span>My List</span></button>
      </nav>

      <AnimatePresence>{filtersOpen && <FilterPanel filters={draftFilters} onChange={setDraftFilters} onClose={() => setFiltersOpen(false)} onApply={() => void applyFilters()} />}</AnimatePresence>
      <AnimatePresence>{vibeOpen && <VibePanel onClose={() => setVibeOpen(false)} onChoose={(ids) => void chooseVibe(ids)} />}</AnimatePresence>
      <AnimatePresence>{modalMode && <TitleModal mode={modalMode} context={context} onClose={() => { setModalMode(null); setContext(null); }} onNext={() => { setModalMode(null); setContext(null); move(1); setTimeout(() => { const next = currentItems[(activeIndex + 1) % currentItems.length]; if (next) void openContext(next, 'channel'); }, 0); }} />}</AnimatePresence>

      <AnimatePresence>{playbackItem && <PlaybackModal item={playbackItem} config={playback} client={api} onClose={() => setPlaybackItem(null)} onSelect={setPlaybackItem} />}</AnimatePresence>
      <footer className="credits">Movie and TV data supplied by TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Watch availability powered by JustWatch.</footer>
    </div>
  );
}

function FilterPanel({ filters, onChange, onClose, onApply }: { filters: DiscoveryFilters; onChange: (next: DiscoveryFilters) => void; onClose: () => void; onApply: () => void }) {
  const toggleGenre = (id: number) => onChange({ ...filters, genreIds: filters.genreIds.includes(id) ? filters.genreIds.filter((genre) => genre !== id) : [...filters.genreIds, id] });
  return <motion.div className="overlay overlay--right" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.aside className="filter-panel" role="dialog" aria-label="Filter your feed" initial={{ x: 80 }} animate={{ x: 0 }} exit={{ x: 80 }}>
      <header><div><Filter /><h2>Filter your feed</h2></div><button aria-label="Close filters" onClick={onClose}><X /></button></header>
      <FilterGroup title="Content">{(['movies', 'tv', 'both'] as const).map((type) => <button key={type} className={filters.contentType === type ? 'active' : ''} onClick={() => onChange({ ...filters, contentType: type })}>{type === 'tv' ? 'TV Shows' : type[0].toUpperCase() + type.slice(1)}</button>)}</FilterGroup>
      <FilterGroup title="Genres">{genres.map(([id, name]) => <button key={id} className={filters.genreIds.includes(id) ? 'active' : ''} onClick={() => toggleGenre(id)}>{name}</button>)}</FilterGroup>
      <FilterGroup title="Release year">{([['new', 'New'], ['2020s', '2020s'], ['2010s', '2010s'], ['2000s', '2000s'], ['90s', '90s'], ['classics', 'Classics']] as [ReleaseEra, string][]).map(([value, label]) => <button key={value} className={filters.releaseEra === value ? 'active' : ''} onClick={() => onChange({ ...filters, releaseEra: value })}>{label}</button>)}</FilterGroup>
      <FilterGroup title="Rating">{[null, 7, 8, 9].map((value) => <button key={String(value)} className={filters.rating === value ? 'active' : ''} onClick={() => onChange({ ...filters, rating: value })}>{value ? `${value}+` : 'Any'}</button>)}</FilterGroup>
      <FilterGroup title="Runtime">{([['any', 'Any'], ['under-90', '< 90m'], ['90-120', '90–120m'], ['over-120', '2h+']] as [RuntimeFilter, string][]).map(([value, label]) => <button key={value} className={filters.runtime === value ? 'active' : ''} onClick={() => onChange({ ...filters, runtime: value })}>{label}</button>)}</FilterGroup>
      <button className="apply-button" onClick={onApply}>Apply filters <SlidersHorizontal /></button>
      <button className="clear-button" onClick={() => onChange(defaultFilters)}>Clear all</button>
    </motion.aside>
  </motion.div>;
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className="filter-group"><p>{title}</p><div>{children}</div></section>; }

function VibePanel({ onClose, onChoose }: { onClose: () => void; onChoose: (ids: readonly number[]) => void }) {
  return <motion.div className="overlay" role="dialog" aria-label="Choose a vibe" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.div className="vibe-panel" initial={{ y: 30, scale: .96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, scale: .97 }}>
      <button className="modal-close" aria-label="Close vibe picker" onClick={onClose}><X /></button><Sparkles className="vibe-icon" />
      <span>Vibe mode</span><h2>What are you in the mood for?</h2><p>Pick a feeling. We’ll tune the feed around it.</p>
      <div>{vibes.map((vibe) => <button key={vibe.name} aria-label={vibe.name} onClick={() => onChoose(vibe.ids)}><b>{vibe.name}</b><span>{vibe.copy}</span><ChevronRight /></button>)}</div>
    </motion.div>
  </motion.div>;
}

function TitleModal({ mode, context, onClose, onNext }: { mode: 'details' | 'trailer' | 'channel'; context: TitleContext | null; onClose: () => void; onNext: () => void }) {
  const providers = context?.providers ? [...(context.providers.flatrate ?? []), ...(context.providers.free ?? []), ...(context.providers.ads ?? []), ...(context.providers.rent ?? [])].filter((provider, index, all) => all.findIndex((item) => item.provider_id === provider.provider_id) === index) : [];
  return <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.div className={`title-modal ${mode === 'channel' ? 'title-modal--channel' : ''}`} role="dialog" aria-label={mode === 'channel' ? 'Channel player' : mode === 'trailer' ? 'Trailer player' : 'Title details'} initial={{ y: 30, scale: .97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, scale: .98 }}>
      <button className="modal-close" aria-label="Close player" onClick={onClose}><X /></button>
      {!context ? <LoadingState /> : <>
        {mode !== 'details' && context.trailer ? <div className="video-frame"><iframe title={`${context.details.title} trailer`} src={`https://www.youtube-nocookie.com/embed/${context.trailer.key}?autoplay=1&playsinline=1&rel=0`} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen /></div> : mode !== 'details' ? <div className="video-missing"><Clapperboard /><p>No official trailer is available for this title.</p></div> : null}
        <div className="title-modal__body"><span>{mode === 'channel' ? 'Now playing' : context.details.mediaType === 'movie' ? 'Movie' : 'Series'}</span><h2>{context.details.title}</h2><p>{context.details.overview}</p>
          <div className="provider-list">{providers.length ? providers.slice(0, 6).map((provider) => <span key={provider.provider_id}>{imageUrl(provider.logo_path, 'w92') && <img src={imageUrl(provider.logo_path, 'w92')!} alt="" />}{provider.provider_name}</span>) : <small>No US streaming provider is currently listed.</small>}</div>
          <div className="modal-actions">{context.providerLink && <a href={context.providerLink} target="_blank" rel="noreferrer"><Play fill="currentColor" /> See where to watch</a>}{mode === 'channel' && <button onClick={onNext}>Next trailer <ChevronRight /></button>}</div>
          {!!providers.length && <small>Streaming availability powered by JustWatch.</small>}
        </div>
      </>}
    </motion.div>
  </motion.div>;
}
