import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Heart, LoaderCircle, Radio, Search, Tv, WifiOff } from 'lucide-react';
import { categoryLabel, loadIptvOrgCatalog, type LiveChannel, type LiveTvCatalog } from '../lib/iptvOrg';
import { LiveTvPlayer } from './LiveTvPlayer';
import '../live-tv.css';

const FAVORITES_KEY = 'glocktv:live-favorites:v1';

export interface LiveTvRouteProps {
  loadCatalog?: () => Promise<LiveTvCatalog>;
  PlayerComponent?: ComponentType<{ channel: LiveChannel }>;
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
  loadCatalog = () => loadIptvOrgCatalog(),
  PlayerComponent = LiveTvPlayer,
}: LiveTvRouteProps) {
  const [catalog, setCatalog] = useState<LiveTvCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [selectedId, setSelectedId] = useState('');
  const [favorites, setFavorites] = useState<string[]>(readFavorites);

  const refresh = () => {
    setLoading(true);
    setError('');
    void loadCatalog()
      .then((result) => {
        setCatalog(result);
        setSelectedId((current) => current || result.channels[0]?.id || '');
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Live TV could not load.'))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, [loadCatalog]);

  useEffect(() => {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites)); } catch { /* optional */ }
  }, [favorites]);

  const categories = useMemo(() => {
    if (!catalog) return [];
    const counts = new Map<string, number>();
    for (const channel of catalog.channels) counts.set(channel.category, (counts.get(channel.category) ?? 0) + 1);
    const preferred = ['News', 'Sports', 'Movies', 'Entertainment', 'Series', 'Kids', 'Music', 'Documentary', 'General'];
    return [...counts.entries()].sort((left, right) => {
      const leftRank = preferred.findIndex((name) => name.toLowerCase() === left[0].toLowerCase());
      const rightRank = preferred.findIndex((name) => name.toLowerCase() === right[0].toLowerCase());
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
      if (category !== 'all' && category !== 'favorites' && channel.category !== category) return false;
      return !term || channel.name.toLowerCase().includes(term) || channel.category.toLowerCase().includes(term);
    });
  }, [catalog, category, favorites, query]);

  const selected = catalog?.channels.find((channel) => channel.id === selectedId)
    ?? filtered[0]
    ?? catalog?.channels[0]
    ?? null;

  const toggleFavorite = (id: string) => {
    setFavorites((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return (
    <main className="live-tv-stage" aria-label="Live TV">
      <header className="live-tv-hero">
        <div>
          <span><Radio /> GLOCKTV LIVE</span>
          <h1>Live TV</h1>
          <p>Public live channels from IPTV-org, filtered for browser-compatible HTTPS streams.</p>
        </div>
        <div className="live-tv-source"><Tv /><strong>IPTV-org</strong><small>United States catalog</small></div>
      </header>

      {loading ? (
        <div className="live-tv-state"><LoaderCircle className="spin" /><strong>Loading live channels</strong><span>Building the browser-safe channel lineup.</span></div>
      ) : error ? (
        <div className="live-tv-state live-tv-state--error"><WifiOff /><strong>Live TV could not load</strong><span>{error}</span><button onClick={refresh}>Try again</button></div>
      ) : catalog && selected ? (
        <div className="live-tv-layout">
          <section className="live-tv-content">
            <PlayerComponent channel={selected} />
            <div className="live-tv-disclaimer">Streams are supplied by their source broadcasters and indexed by IPTV-org. Availability can change without notice.</div>
          </section>

          <aside className="live-tv-browser">
            <div className="live-tv-search">
              <Search />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search live channels..." aria-label="Search live channels" />
            </div>

            <div className="live-tv-categories" aria-label="Live TV categories">
              <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>All</button>
              <button className={category === 'favorites' ? 'active' : ''} onClick={() => setCategory('favorites')}>Favorites</button>
              {categories.slice(0, 8).map(([name]) => (
                <button key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>{categoryLabel(name)}</button>
              ))}
            </div>

            <div className="live-tv-count"><strong>{filtered.length}</strong> channels</div>
            <div className="live-tv-list">
              {filtered.length ? filtered.map((channel) => (
                <article key={channel.id} className={channel.id === selected.id ? 'active' : ''}>
                  <button className="live-tv-channel" onClick={() => setSelectedId(channel.id)} aria-label={`Watch ${channel.name}`}>
                    <span className="live-tv-channel__logo">
                      {channel.logo ? <img src={channel.logo} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <Tv />}
                    </span>
                    <span className="live-tv-channel__copy"><strong>{channel.name}</strong><small>{categoryLabel(channel.category)} - {channel.streams.length} source{channel.streams.length === 1 ? '' : 's'}</small></span>
                    <span className="live-tv-channel__dot" />
                  </button>
                  <button className={`live-tv-favorite ${favorites.includes(channel.id) ? 'active' : ''}`} aria-label={`${favorites.includes(channel.id) ? 'Remove' : 'Add'} ${channel.name} ${favorites.includes(channel.id) ? 'from' : 'to'} favorites`} onClick={() => toggleFavorite(channel.id)}><Heart fill={favorites.includes(channel.id) ? 'currentColor' : 'none'} /></button>
                </article>
              )) : <div className="live-tv-empty"><Search /><strong>No channels found</strong><span>Try another category or search.</span></div>}
            </div>
          </aside>
        </div>
      ) : null}
    </main>
  );
}
