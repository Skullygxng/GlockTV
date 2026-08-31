import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Search, Swords, WifiOff } from 'lucide-react';
import {
  PpvCatalogError,
  derivePpvStatus,
  formatPpvCountdown,
  formatPpvStart,
  type PpvCatalog,
  type PpvCategory,
  type PpvEvent,
  type PpvStatus,
} from '../lib/ppv';
import { loadPpvPlatformCatalog } from '../lib/ppvCatalogAggregator';
import { PpvPlayer } from './PpvPlayer';
import { PpvDiagnosticsPanel } from './PpvDiagnosticsPanel';
import {
  isPpvDebugEnabled,
  sanitizeDiagnosticString,
  type PpvCatalogDiagnostics,
} from '../lib/ppvDiagnostics';
import { safePpvPosterUrl } from '../lib/ppvPosterPolicy';
import '../ppv.css';

interface PpvPanelProps {
  loadCatalog?: typeof loadPpvPlatformCatalog;
  /*
   * Lets Live TV know a PPV event is being watched. The mobile layout hides the
   * player column unless the stage is in watching mode, and PPV selection lives
   * in here rather than in Live TV's channel state.
   */
  onWatchingChange?: (watching: boolean) => void;
  /* Off by default; enabled per-session with ?ppvdebug=1. */
  debug?: boolean;
}

/* Countdown ticks once a minute; the catalog itself refreshes far less often. */
const PPV_CLOCK_INTERVAL_MS = 60_000;
const PPV_CATALOG_REFRESH_MS = 5 * 60_000;
const PPV_CATALOG_STALE_MS = 2 * 60_000;

const FILTERS: Array<{ id: 'all' | 'live' | 'upcoming' | PpvCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'live', label: 'Live now' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'mma', label: 'MMA' },
  { id: 'boxing', label: 'Boxing' },
  { id: 'wrestling', label: 'Wrestling' },
];

/*
 * Request errors name the URL they failed on, and that message is rendered to
 * the user, so anything URL-shaped is replaced with the generic line.
 */
function catalogErrorMessage(reason: unknown): string {
  const fallback = 'PPV events could not load.';
  if (!(reason instanceof Error) || !reason.message) return fallback;
  return sanitizeDiagnosticString(reason.message) === reason.message ? reason.message : fallback;
}

/* Let an upcoming card flip to live on the clock, but never downgrade a status
   the provider itself reported as live. */
function freshStatus(event: PpvEvent, now: number): PpvStatus {
  if (event.status === 'live') return 'live';
  const startsAt = Date.parse(event.startsAt);
  if (!Number.isFinite(startsAt)) return event.status;
  return derivePpvStatus(startsAt, now);
}

export function PpvPanel({
  loadCatalog = loadPpvPlatformCatalog,
  onWatchingChange,
  debug,
}: PpvPanelProps) {
  const [catalog, setCatalog] = useState<PpvCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [selectedId, setSelectedId] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [catalogDiagnostics, setCatalogDiagnostics] = useState<PpvCatalogDiagnostics | null>(null);

  const debugEnabled = debug ?? isPpvDebugEnabled();

  const inFlight = useRef(false);

  const refresh = useCallback(
    (background = false) => {
      // One catalog request at a time: periodic, visibility and manual refresh
      // must not stack into a request storm.
      if (inFlight.current) return;
      inFlight.current = true;
      if (!background) setLoading(true);
      void loadCatalog()
        .then((result) => {
          setCatalog(result);
          setCatalogDiagnostics(result.diagnostics ?? null);
          setError('');
          setSelectedId((current) =>
            result.events.some((event) => event.providerEventId === current) ? current : '',
          );
        })
        .catch((reason) => {
          // Keep the last good catalog on screen; a failed refresh must not
          // blank a list the user is reading. The diagnostics ride out on the
          // typed error, so a catalog that never loaded can still say why.
          setCatalogDiagnostics(reason instanceof PpvCatalogError ? reason.diagnostics : null);
          setError(catalogErrorMessage(reason));
        })
        .finally(() => {
          inFlight.current = false;
          if (!background) setLoading(false);
        });
    },
    [loadCatalog],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PPV_CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => refresh(true), PPV_CATALOG_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const loadedAt = catalog?.loadedAt;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      const age = loadedAt ? Date.now() - Date.parse(loadedAt) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(age) || age > PPV_CATALOG_STALE_MS) refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadedAt, refresh]);

  const events = useMemo(() => {
    if (!catalog) return [];
    const term = query.trim().toLowerCase();
    return catalog.events
      .map((event) => ({ event, status: freshStatus(event, now) }))
      .filter(({ event, status }) => {
        if (filter === 'live' && status !== 'live') return false;
        if (filter === 'upcoming' && status !== 'upcoming') return false;
        if (filter === 'mma' || filter === 'boxing' || filter === 'wrestling') {
          if (event.category !== filter) return false;
        }
        if (!term) return true;
        return `${event.title} ${event.promotion ?? ''} ${event.category}`.toLowerCase().includes(term);
      });
  }, [catalog, filter, now, query]);

  const selected =
    selectedId && catalog
      ? (catalog.events.find((event) => event.providerEventId === selectedId) ?? null)
      : null;

  const watching = Boolean(selected);
  useEffect(() => {
    onWatchingChange?.(watching);
  }, [onWatchingChange, watching]);

  useEffect(
    () => () => {
      onWatchingChange?.(false);
    },
    [onWatchingChange],
  );

  /*
   * Two ways to be stale, and they read differently to the viewer: a refresh
   * that failed over a catalog already on screen, and a catalog served from the
   * local cache because no provider answered at all. Neither is an empty list.
   */
  const cacheAgeMinutes =
    catalog?.diagnostics?.cacheAgeMs != null
      ? Math.max(1, Math.round(catalog.diagnostics.cacheAgeMs / 60_000))
      : 0;
  const staleNotice = error && catalog ? error : '';
  const catalogDebug = catalog?.diagnostics;
  const cachedNotice = staleNotice
    ? ''
    : catalogDebug?.partialCoverage
      ? /*
         * A provider answered only part of the window it was asked about, so
         * this list is not authoritative about what is missing from it.
         */
        catalogDebug.fromCache
        ? `Some catalog sources did not answer. Showing the last known list from ${cacheAgeMinutes}m ago; some events may be missing.`
        : 'Some catalog sources did not answer. Some events may be missing.'
      : catalogDebug?.fromCache
        ? `No catalog provider answered. Showing the cached list from ${cacheAgeMinutes}m ago.`
        : '';

  return (
    <div className="live-tv-layout" aria-label="PPV events">
      <section className="live-tv-content">
        {selected ? (
          <PpvPlayer
            event={{ ...selected, status: freshStatus(selected, now) }}
            debug={debugEnabled}
            catalogDiagnostics={catalogDiagnostics}
          />
        ) : (
          <div className="live-player live-player--idle" aria-label="No PPV event selected">
            <div className="live-player__video live-player__video--idle">
              <div className="live-player__idle-message">
                <Swords />
                <strong>Choose a PPV event</strong>
                <span>
                  Live and upcoming fight cards. Hosted player availability varies by event; some
                  events link to the official provider instead.
                </span>
              </div>
            </div>
          </div>
        )}
        <div className="live-tv-disclaimer">
          PPV listings come from TheSportsDB and Streamed.pk. Hosted player availability varies by
          event and can change without notice. Existing Live TV channels are unchanged.
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
        {staleNotice && (
          <div className="ppv-stale" role="status">
            <WifiOff />
            <span>Showing the last loaded fight cards. {staleNotice}</span>
            <button type="button" onClick={() => refresh()}>
              Retry
            </button>
          </div>
        )}
        {cachedNotice && (
          <div className="ppv-stale" role="status">
            <WifiOff />
            <span>{cachedNotice}</span>
            <button type="button" onClick={() => refresh()}>
              Retry
            </button>
          </div>
        )}
        {/*
         * Diagnostics for the no-selection state live here, not in
         * .live-tv-content: below 900px that column is display:none until an
         * event is being watched, and a catalog failure leaves nothing to
         * select - so the panel explaining the failure was hidden by the
         * failure itself. This surface stays visible either way.
         */}
        {debugEnabled && !selected && <PpvDiagnosticsPanel catalog={catalogDiagnostics} />}
        <div className="live-tv-list">
          {loading ? (
            <div className="live-tv-empty">
              <LoaderCircle className="spin" />
              <strong>Loading fight cards</strong>
            </div>
          ) : error && !catalog ? (
            <div className="live-tv-empty">
              <WifiOff />
              <strong>PPV could not load</strong>
              <span>{error}</span>
              <button type="button" onClick={() => refresh()}>
                Try again
              </button>
            </div>
          ) : events.length ? (
            events.map(({ event, status }) => (
              <PpvEventRow
                key={event.providerEventId}
                event={event}
                status={status}
                now={now}
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
  status,
  now,
  active,
  onSelect,
}: {
  event: PpvEvent;
  status: PpvStatus;
  now: number;
  active: boolean;
  onSelect: () => void;
}) {
  /*
   * The last gate before a provider-supplied URL becomes a request the
   * browser makes on its own. Mapping and the cache both apply the same
   * policy; this is here so no future path can reach an <img src> without it.
   */
  const poster = safePpvPosterUrl(event.poster);
  const [posterFailed, setPosterFailed] = useState(false);

  return (
    <article className={active ? 'active' : ''} data-ppv-id={event.providerEventId}>
      <button type="button" className="live-tv-channel" onClick={onSelect} aria-label={`Watch ${event.title}`}>
        <span className="live-tv-channel__logo">
          {poster && !posterFailed ? (
            <img
              src={poster}
              alt=""
              loading="lazy"
              // Falling back to the icon rather than hiding the image keeps the
              // row looking intentional instead of leaving an empty square.
              onError={() => setPosterFailed(true)}
            />
          ) : (
            <Swords />
          )}
        </span>
        <span className="live-tv-channel__copy">
          <strong>{event.title}</strong>
          <small>
            {status === 'live' ? 'LIVE' : formatPpvCountdown(event.startsAt, now)} · {event.category} ·{' '}
            {formatPpvStart(event.startsAt)}
          </small>
        </span>
        {active && <span className="live-tv-channel__dot" />}
      </button>
    </article>
  );
}
