import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Search, Swords, WifiOff } from 'lucide-react';
import {
  formatPpvCountdown,
  formatPpvStart,
  loadPpvCatalog,
  type PpvCatalog,
  type PpvCategory,
  type PpvEvent,
} from '../lib/ppv';
import { PpvPlayer } from './PpvPlayer';

interface PpvPanelProps {
  loadCatalog?: typeof loadPpvCatalog;
}

const FILTERS: Array<{ id: 'all' | 'live' | 'upcoming' | PpvCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live now' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'mma', label: 'MMA' },
  { id: 'boxing', label: 'Boxing' },
  { id: 'wrestling', label: 'Wrestling' },
];

export function PpvPanel({ loadCatalog = loadPpvCatalog }: PpvPanelProps) {
  const [catalog, setCatalog] = useState<PpvCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [selectedId, setSelectedId] = useState('');

  const refresh = () => {
    setLoading(true);
    setError('');
    void loadCatalog()
      .then((result) => {
        setCatalog(result);
        setSelectedId((current) =>
          result.events.some((event) => event.providerEventId === current) ? current : '',
        );
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'PPV events could not load.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, [loadCatalog]);

  const events = useMemo(() => {
    if (!catalog) return [];
    const term = query.trim().toLowerCase();
    return catalog.events.filter((event) => {
      if (filter === 'live' && event.status !== 'live') return false;
      if (filter === 'upcoming' && event.status !== 'upcoming') return false;
      if (filter === 'mma' || filter === 'boxing' || filter === 'wrestling') {
        if (event.category !== filter) return false;
      }
      if (!term) return true;
      return `${event.title} ${event.promotion ?? ''} ${event.category}`.toLowerCase().includes(term);
    });
  }, [catalog, filter, query]);

  const selected =
    selectedId && catalog
      ? (catalog.events.find((event) => event.providerEventId === selectedId) ?? null)
      : null;

  return (
    <div className="live-tv-layout" aria-label="PPV events">
      <section className="live-tv-content">
        {selected ? (
          <PpvPlayer event={selected} />
        ) : (
          <div className="live-player live-player--idle" aria-label="No PPV event selected">
            <div className="live-player__video live-player__video--idle">
              <div className="live-player__idle-message">
                <Swords />
                <strong>Choose a PPV event</strong>
                <span>Live and upcoming fight cards from Streamed, with SportSRC embed backup.</span>
              </div>
            </div>
          </div>
        )}
        <div className="live-tv-disclaimer">
          PPV listings come from Streamed.pk. Embeds are hosted player URLs from Streamed and SportSRC.
          Availability changes without notice. Existing Live TV channels are unchanged.
        </div>
      </section>

      <aside className="live-tv-browser">
        <div className="live-tv-search">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search fights..."
            aria-label="Search PPV events"
          />
        </div>
        <div className="live-tv-categories" aria-label="PPV filters">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={filter === item.id ? 'active' : ''}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="live-tv-count">
          <strong>{events.length}</strong> events
        </div>
        <div className="live-tv-list">
          {loading ? (
            <div className="live-tv-empty">
              <LoaderCircle className="spin" />
              <strong>Loading fight cards</strong>
            </div>
          ) : error ? (
            <div className="live-tv-empty">
              <WifiOff />
              <strong>PPV could not load</strong>
              <span>{error}</span>
              <button type="button" onClick={refresh}>
                Try again
              </button>
            </div>
          ) : events.length ? (
            events.map((event) => (
              <PpvEventRow
                key={event.providerEventId}
                event={event}
                active={event.providerEventId === selectedId}
                onSelect={() => setSelectedId(event.providerEventId)}
              />
            ))
          ) : (
            <div className="live-tv-empty">
              <Search />
              <strong>No PPV events found</strong>
              <span>Try another filter or search.</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function PpvEventRow({
  event,
  active,
  onSelect,
}: {
  event: PpvEvent;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={active ? 'active' : ''} data-ppv-id={event.providerEventId}>
      <button type="button" className="live-tv-channel" onClick={onSelect} aria-label={`Watch ${event.title}`}>
        <span className="live-tv-channel__logo">
          {event.poster ? (
            <img
              src={event.poster}
              alt=""
              loading="lazy"
              onError={(current) => {
                current.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <Swords />
          )}
        </span>
        <span className="live-tv-channel__copy">
          <strong>{event.title}</strong>
          <small>
            {event.status === 'live' ? 'LIVE' : formatPpvCountdown(event.startsAt)} · {event.category} ·{' '}
            {formatPpvStart(event.startsAt)}
          </small>
        </span>
        {active && <span className="live-tv-channel__dot" />}
      </button>
    </article>
  );
}
