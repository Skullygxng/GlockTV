import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Heart, LoaderCircle, Radio, Search, Tv, WifiOff, X } from 'lucide-react';
import {
  categoryLabel,
  clearIptvOrgCatalogCache,
  defaultLoadCatalog,
  PREFERRED_CATEGORIES,
  type LiveChannel,
  type LiveTvCatalog,
} from '../lib/iptvOrg';
import { LiveTvPlayer } from './LiveTvPlayer';
import { PpvPanel } from './PpvPanel';
import '../live-tv.css';

const FAVORITES_KEY = 'glocktv:live-favorites:v1';
const BATCH_SIZE = 50;

export interface LiveTvRouteProps {
  loadCatalog?: () => Promise<LiveTvCatalog>;
  PlayerComponent?: ComponentType<{ channel: LiveChannel }>;
  onClose?: () => void;
}

function readFavorites() {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function LiveTvRoute({
  loadCatalog = defaultLoadCatalog,
  PlayerComponent = LiveTvPlayer,
  onClose,
}: LiveTvRouteProps) {
  const [catalog, setCatalog] = useState<LiveTvCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [favorites, setFavorites] = useState<string[]>(readFavorites);
  const [visibleCount, setVisibleCount] = useState(BATCH_SIZE);
  const [pane, setPane] = useState<'channels' | 'ppv'>('channels');
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(
    (force = false) => {
      setLoading(true);
      setError('');
      if (force) clearIptvOrgCatalogCache();
      void loadCatalog()
        .then((result) => {
          setCatalog(result);
          setSelectedId('');
          setVisibleCount(BATCH_SIZE);
        })
        .catch((reason) =>
          setError(reason instanceof Error ? reason.message : 'Live TV could not load.'),
        )
        .finally(() => setLoading(false));
    },
    [loadCatalog],
  );

  useEffect(() => {
    refresh(false);
  }, [refresh]);

  useEffect(() => {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    } catch {
      /* optional */
    }
  }, [favorites]);

  useEffect(() => {
    setVisibleCount(BATCH_SIZE);
  }, [category, query]);

  const categories = useMemo(() => {
    if (!catalog) return [];
    const counts = new Map<string, number>();
    for (const channel of catalog.channels) {
      for (const cat of channel.categories?.length ? channel.categories : [channel.category]) {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((left, right) => {
      const leftRank = PREFERRED_CATEGORIES.findIndex(
        (name) => name.toLowerCase() === left[0].toLowerCase(),
      );
      const rightRank = PREFERRED_CATEGORIES.findIndex(
        (name) => name.toLowerCase() === right[0].toLowerCase(),
      );
      if (leftRank >= 0 || rightRank >= 0) {
        if (leftRank < 0) return 1;
        if (rightRank < 0) return -1;
        return leftRank - rightRank;
      }
      return right[1] - left[1];
    });
  }, [catalog]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const term = query.trim().toLowerCase();
    return catalog.channels.filter((channel) => {
      if (category === 'favorites' && !favorites.includes(channel.id)) return false;
      if (category !== 'all' && category !== 'favorites') {
        const cats = channel.categories?.length ? channel.categories : [channel.category];
        if (!cats.some((c) => c === category)) return false;
      }
      if (!term) return true;
      const haystack = `${channel.displayName || channel.name} ${channel.category} ${(channel.categories || []).join(' ')}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [catalog, category, favorites, query]);

  useEffect(() => {
    if (!selectedId) return;
    const stillVisible = filtered.some((channel) => channel.id === selectedId);
    if (!stillVisible) {
      setSelectedId('');
    }
  }, [filtered, selectedId]);

  const selected =
    selectedId && catalog
      ? (catalog.channels.find((channel) => channel.id === selectedId) ?? null)
      : null;

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  const toggleFavorite = (id: string) => {
    setFavorites((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const handleRetry = () => refresh(true);

  return (
    <main className={`live-tv-stage${selected ? ' live-tv-stage--watching' : ''}`} aria-label="Live TV">
      <header className="live-tv-hero">
        <div>
          <span>
            <Radio /> GLOCKTV LIVE
          </span>
          <h1>Live TV</h1>
          <p>
            {pane === 'ppv'
              ? 'Live and upcoming fight cards with hosted embeds from Streamed and SportSRC.'
              : 'Public live channels from IPTV-org, filtered for browser-compatible HTTPS streams.'}
          </p>
        </div>
        <div className="live-tv-hero__actions">
          <div className="live-tv-source">
            <Tv />
            <strong>{pane === 'ppv' ? 'Streamed.pk' : 'IPTV-org'}</strong>
            <small>{pane === 'ppv' ? 'PPV hosted embeds' : 'United States catalog'}</small>
          </div>
          {onClose && (
            <button type="button" className="live-tv-close" aria-label="Close Live TV" onClick={onClose}>
              <X />
            </button>
          )}
        </div>
      </header>

      <div className="live-tv-tabs" role="tablist" aria-label="Live sections">
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'channels'}
          className={pane === 'channels' ? 'active' : ''}
          onClick={() => setPane('channels')}
        >
          Channels
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === 'ppv'}
          className={pane === 'ppv' ? 'active' : ''}
          onClick={() => setPane('ppv')}
        >
          PPV
        </button>
      </div>

      {pane === 'ppv' ? (
        <PpvPanel />
      ) : loading ? (
        <div className="live-tv-state">
          <LoaderCircle className="spin" />
          <strong>Loading live channels</strong>
          <span>Building the browser-safe channel lineup.</span>
        </div>
      ) : error ? (
        <div className="live-tv-state live-tv-state--error">
          <WifiOff />
          <strong>Live TV could not load</strong>
          <span>{error}</span>
          <button type="button" onClick={handleRetry}>
            Try again
          </button>
        </div>
      ) : catalog ? (
        <div className="live-tv-layout">
          <section className="live-tv-content" id="live-tv-player">
            {selected ? (
              <PlayerComponent channel={selected} />
            ) : (
              <div className="live-player live-player--idle" aria-label="No channel selected">
                <div className="live-player__video live-player__video--idle">
                  <div className="live-player__idle-message">
                    <Tv />
                    <strong>Choose a channel to start watching live TV</strong>
                    <span>Select any channel from the lineup below.</span>
                  </div>
                </div>
              </div>
            )}
            <div className="live-tv-disclaimer">
              Streams are supplied by their source broadcasters and indexed by IPTV-org. Availability
              can change without notice.
            </div>
          </section>

          <aside className="live-tv-browser">
            <div className="live-tv-search">
              <Search />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search live channels..."
                aria-label="Search live channels"
              />
            </div>

            <div className="live-tv-categories" aria-label="Live TV categories">
              <button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>
                All
              </button>
              <button type="button" className={category === 'favorites' ? 'active' : ''} onClick={() => setCategory('favorites')}>
                Favorites
              </button>
              {categories.slice(0, 10).map(([name]) => (
                <button type="button" key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>
                  {categoryLabel(name)}
                </button>
              ))}
            </div>

            <div className="live-tv-count">
              <strong>{filtered.length}</strong> channels
              {filtered.length > 0 && (
                <span className="live-tv-count__visible">
                  {' '}
                  · showing {Math.min(visibleCount, filtered.length)}
                </span>
              )}
            </div>

            <div className="live-tv-list" ref={listRef}>
              {filtered.length ? (
                <>
                  {visible.map((channel) => {
                    const title = channel.displayName || channel.name;
                    const isActive = channel.id === selectedId;
                    return (
                      <article key={channel.id} data-channel-id={channel.id} className={isActive ? 'active' : ''}>
                        <button type="button" className="live-tv-channel" onClick={() => setSelectedId(channel.id)} aria-label={`Watch ${title}`}>
                          <span className="live-tv-channel__logo">
                            {channel.logo ? (
                              <img src={channel.logo} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} />
                            ) : (
                              <Tv />
                            )}
                          </span>
                          <span className="live-tv-channel__copy">
                            <strong>{title}</strong>
                            <small>
                              {categoryLabel(channel.category)} · {channel.streams.length} source
                              {channel.streams.length === 1 ? '' : 's'}
                            </small>
                          </span>
                          {isActive && <span className="live-tv-channel__dot" />}
                        </button>
                        <button
                          type="button"
                          className={`live-tv-favorite ${favorites.includes(channel.id) ? 'active' : ''}`}
                          aria-label={`${favorites.includes(channel.id) ? 'Remove' : 'Add'} ${title} ${favorites.includes(channel.id) ? 'from' : 'to'} favorites`}
                          onClick={() => toggleFavorite(channel.id)}
                        >
                          <Heart fill={favorites.includes(channel.id) ? 'currentColor' : 'none'} />
                        </button>
                      </article>
                    );
                  })}
                  {hasMore && (
                    <div className="live-tv-load-more">
                      <button type="button" onClick={() => setVisibleCount((count) => count + BATCH_SIZE)}>
                        Load more ({filtered.length - visibleCount} remaining)
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="live-tv-empty">
                  <Search />
                  <strong>No channels found</strong>
                  <span>Try another category or search.</span>
                </div>
              )}
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
