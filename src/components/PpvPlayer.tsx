import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, LoaderCircle, Radio, RotateCw, SkipForward, Tv } from 'lucide-react';
import type { PpvEmbed, PpvEvent, PpvPlaybackSource } from '../lib/ppv';
import { formatPpvStart, loadPpvEmbeds } from '../lib/ppv';
import { discoverPpvEmbeds } from '../lib/ppv';
import {
  PPV_IFRAME_PROBE_MS,
  PPV_SOURCE_LOAD_DEADLINE_MS,
  diagnosticHostname,
  emptyEventDiagnostics,
  emptyFailoverDiagnostics,
  emptyIframeDiagnostics,
  isPpvDebugEnabled,
  type PpvAdvanceReason,
  type PpvCatalogDiagnostics,
  type PpvEventDiagnostics,
  type PpvFailoverDiagnostics,
  type PpvIframeDiagnostics,
} from '../lib/ppvDiagnostics';
import { PpvDiagnosticsPanel } from './PpvDiagnosticsPanel';
import {
  PPV_IFRAME_ALLOW,
  PPV_IFRAME_REFERRER_POLICY,
  PPV_IFRAME_SANDBOX,
} from '../lib/ppvEmbedPolicy';
import { mergePpvPlaybackSources } from '../lib/ppvProviders';
import {
  ppvEmbedToPlaybackSource,
  resolvePpvPlayback,
  type PpvPlaybackResult,
} from '../lib/ppvPlaybackRegistry';

interface PpvPlayerProps {
  event: PpvEvent;
  /* Legacy injection point kept for existing callers and tests. */
  loadEmbeds?: typeof loadPpvEmbeds;
  /* Diagnostic-capable embed discovery; superseded by resolveSources. */
  discoverEmbeds?: typeof discoverPpvEmbeds;
  /* The playback registry. Default in production; injected in tests. */
  resolveSources?: (event: PpvEvent) => Promise<PpvPlaybackResult>;
  debug?: boolean;
  /* Rendered alongside playback diagnostics so one panel covers the chain. */
  catalogDiagnostics?: PpvCatalogDiagnostics | null;
}

/* Safe secondary line for normal users - never provider internals. */
const UNAVAILABLE_HINT = 'No compatible hosted player was returned.';
/*
 * Zero inline sources is a normal outcome, not a failure: most fight cards are
 * simply not available as a hosted embed. What the viewer is told depends on
 * what we actually know. A watch destination is somewhere a provider says the
 * event can be watched; an information page is the promotion's own page and is
 * never described as a way to watch.
 */
const OFFICIAL_WATCH_HINT =
  'No inline source for this event. It can be watched at the official provider.';
const OFFICIAL_INFO_HINT =
  'No inline source for this event. The official page has the event details.';
/*
 * Every source was mounted and none produced a document load event. That is a
 * load failure, and it is all it is: a cross-origin frame cannot tell us
 * whether video would have played, so the wording never says it did not.
 */
const EXHAUSTED_TITLE = 'No source loaded';
const EXHAUSTED_HINT = 'None of the available sources could be loaded.';

function zeroSourceHint(event: PpvEvent): string {
  if (event.officialWatchUrl) return OFFICIAL_WATCH_HINT;
  if (event.officialInfoUrl) return OFFICIAL_INFO_HINT;
  return UNAVAILABLE_HINT;
}

function inlineSourcesFor(event: PpvEvent): PpvPlaybackSource[] {
  return mergePpvPlaybackSources([
    ...(event.playbackSources ?? []),
    ...event.embeds.map((embed: PpvEmbed) => ppvEmbedToPlaybackSource(embed)),
  ]);
}

export function PpvPlayer({
  event,
  loadEmbeds,
  discoverEmbeds,
  resolveSources,
  debug,
  catalogDiagnostics,
}: PpvPlayerProps) {
  const [sources, setSources] = useState<PpvPlaybackSource[]>(() => inlineSourcesFor(event));
  const [loading, setLoading] = useState(!inlineSourcesFor(event).length);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [diagnostics, setDiagnostics] = useState<PpvEventDiagnostics | null>(null);
  const [iframeTrace, setIframeTrace] = useState<PpvIframeDiagnostics>(emptyIframeDiagnostics);
  const [failover, setFailover] = useState<PpvFailoverDiagnostics>(emptyFailoverDiagnostics);

  const debugEnabled = debug ?? isPpvDebugEnabled();
  const officialWatchUrl = event.officialWatchUrl ?? '';
  const officialInfoUrl = event.officialInfoUrl ?? '';

  /*
   * Resolution order: an explicit registry, then the legacy discovery props,
   * then the production registry. The player itself stays agnostic - whatever
   * it is handed, it renders as normalized sources.
   */
  const resolve = useMemo<(target: PpvEvent) => Promise<PpvPlaybackResult>>(() => {
    if (resolveSources) return resolveSources;
    if (discoverEmbeds) {
      return async (target) => {
        const result = await discoverEmbeds(target);
        return {
          sources: mergePpvPlaybackSources(result.embeds.map(ppvEmbedToPlaybackSource)),
          diagnostics: result.diagnostics,
        };
      };
    }
    if (loadEmbeds) {
      return async (target) => ({
        sources: mergePpvPlaybackSources((await loadEmbeds(target)).map(ppvEmbedToPlaybackSource)),
        diagnostics: emptyEventDiagnostics(target.providerEventId),
      });
    }
    return (target) => resolvePpvPlayback(target);
  }, [discoverEmbeds, loadEmbeds, resolveSources]);

  /*
   * Every resolution carries a generation. Initial loads and Reload share the
   * counter, so a late result from a previous event or a superseded reload can
   * never commit state over the event the user is actually watching.
   */
  const generation = useRef(0);
  const eventRef = useRef(event);
  eventRef.current = event;
  const eventKey = `${event.provider}:${event.providerEventId}`;

  const runLoad = useCallback(
    (target: PpvEvent) => {
      const ticket = ++generation.current;
      documentLoaded.current = new Set<number>();
      userSelected.current = false;
      setLoading(true);
      setError('');
      void resolve(target)
        .then((result) => {
          if (generation.current !== ticket) return;
          setSources(result.sources);
          setDiagnostics(result.diagnostics);
          setIndex(0);
          setFailover({ ...emptyFailoverDiagnostics(), sourceCount: result.sources.length });
          if (!result.sources.length) setError(zeroSourceHint(target));
        })
        .catch(() => {
          if (generation.current !== ticket) return;
          setSources([]);
          setError(zeroSourceHint(target));
        })
        .finally(() => {
          if (generation.current !== ticket) return;
          setLoading(false);
        });
    },
    [resolve],
  );

  useEffect(() => {
    const target = eventRef.current;
    // Drop the previous event's sources immediately so its iframe can never be
    // shown underneath the new event's metadata.
    setIndex(0);
    setError('');
    setDiagnostics(null);
    documentLoaded.current = new Set<number>();
    userSelected.current = false;
    setIframeTrace(emptyIframeDiagnostics());
    setFailover(emptyFailoverDiagnostics());
    const inline = inlineSourcesFor(target);
    if (inline.length) {
      generation.current += 1;
      setSources(inline);
      setFailover({ ...emptyFailoverDiagnostics(), sourceCount: inline.length });
      setLoading(false);
      return;
    }
    setSources([]);
    runLoad(target);
  }, [eventKey, runLoad]);

  const source = sources[Math.min(index, Math.max(0, sources.length - 1))];
  const sourceUrl = source?.url ?? '';

  /*
   * Which source indexes produced a document load event. Held in a ref because
   * the deadline timer has to read it at the moment it fires, and it is only
   * ever a load-event record - it is not, and must not be read as, evidence
   * that anything played.
   */
  const documentLoaded = useRef(new Set<number>());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /*
   * Once the viewer picks a source by hand, automatic failover stops for this
   * event. Moving someone off the source they just chose is worse than leaving
   * them on a dead one, and they still have the Source and Reload buttons.
   */
  const userSelected = useRef(false);

  /*
   * Advancing is only ever driven by a signal a cross-origin frame actually
   * produces: an error event, or the absence of any load event inside the
   * deadline. Neither is a playback signal, and no state here is named as one.
   * There is no wrap-around: once the last source has failed the same way, the
   * run is exhausted and the viewer is told, rather than being cycled forever.
   */
  const advance = useCallback(
    (from: number, reason: PpvAdvanceReason) => {
      if (from + 1 >= sources.length) {
        setFailover((current) => ({ ...current, exhausted: true }));
        return;
      }
      setFailover((current) => {
        const attempt = current.attempts.find((entry) => entry.index === from);
        if (!attempt || attempt.advanced) return current;
        return {
          ...current,
          attempts: current.attempts.map((entry) =>
            entry.index === from ? { ...entry, advanced: true, advanceReason: reason } : entry,
          ),
        };
      });
      setIndex((current) => (current === from ? from + 1 : current));
    },
    [sources.length],
  );

  /*
   * Records that the frame mounted and, later, whether it is still mounted.
   * None of this proves video is playing - only that a document loaded.
   */
  useEffect(() => {
    if (!sourceUrl) {
      setIframeTrace(emptyIframeDiagnostics());
      return;
    }
    let unmounted = false;
    const hostname = diagnosticHostname(sourceUrl);
    setIframeTrace({
      ...emptyIframeDiagnostics(),
      mounted: true,
      hostname,
      mountedAt: Date.now(),
    });
    setFailover((current) => {
      if (current.attempts.some((entry) => entry.index === index)) {
        return { ...current, currentIndex: index, sourceCount: sources.length };
      }
      return {
        ...current,
        sourceCount: sources.length,
        currentIndex: index,
        attempts: [
          ...current.attempts,
          {
            index,
            providerId: source?.providerId ?? 'unknown',
            hostname,
            documentLoaded: false,
            advanced: false,
            advanceReason: null,
          },
        ],
      };
    });

    const probe = setTimeout(() => {
      setIframeTrace((current) => ({ ...current, presentAfterProbe: !unmounted }));
    }, PPV_IFRAME_PROBE_MS);

    // Absence of a load event inside the deadline is the only load failure a
    // cross-origin frame reliably exposes. Its presence proves only that a
    // document loaded, so it is never recorded as playback.
    const deadline = setTimeout(() => {
      if (unmounted || userSelected.current || documentLoaded.current.has(index)) return;
      advance(index, 'no_load_event_within_deadline');
    }, PPV_SOURCE_LOAD_DEADLINE_MS);

    /*
     * React does not attach an error listener to an iframe, so it is bound
     * directly. A cross-origin frame usually fires load even for an error
     * page, so this rarely fires in practice - the deadline above is the
     * dependable signal, and this is the cheap extra one when it exists.
     */
    const frame = frameRef.current;
    const onFrameError = () => {
      if (unmounted || userSelected.current) return;
      setIframeTrace((current) => ({ ...current, loadErrorEvent: true }));
      advance(index, 'iframe_error_event');
    };
    frame?.addEventListener('error', onFrameError);

    return () => {
      unmounted = true;
      clearTimeout(probe);
      clearTimeout(deadline);
      frame?.removeEventListener('error', onFrameError);
      setIframeTrace((current) =>
        current.presentAfterProbe === null ? { ...current, unmountedBeforeProbe: true } : current,
      );
    };
  }, [advance, index, source?.providerId, sourceUrl, sources.length]);

  const sourceLabel = source?.label ?? '';

  const nextSource = () => {
    if (sources.length < 2) return;
    userSelected.current = true;
    setFailover((current) => ({
      ...current,
      attempts: current.attempts.map((entry) =>
        entry.index === index && !entry.advanced
          ? { ...entry, advanced: true, advanceReason: 'user_requested' }
          : entry,
      ),
    }));
    setIndex((current) => (current + 1) % sources.length);
  };

  /*
   * Exhaustion is a user-visible state, not a diagnostics-only flag. Leaving
   * the last failed frame mounted told the viewer nothing at all, which made
   * the claim that they are told when sources run out simply untrue.
   */
  const exhausted = failover.exhausted && sources.length > 0;
  const idle = !source || exhausted;
  const showWatch = idle && !loading && Boolean(officialWatchUrl);
  const showInfo = idle && !loading && !showWatch && Boolean(officialInfoUrl);

  const retrySources = () => runLoad(eventRef.current);

  const idleTitle = loading
    ? 'Loading hosted embed'
    : exhausted
      ? EXHAUSTED_TITLE
      : showWatch
        ? 'Watch on official provider'
        : showInfo
          ? 'Official event information'
          : 'Embed unavailable';

  const idleHint = loading
    ? 'Looking for a hosted player.'
    : exhausted
      ? EXHAUSTED_HINT
      : error;

  return (
    <div className="live-player" aria-label="PPV player">
      {/* One aspect-ratio viewport. Loading, official-provider and unavailable
          states render inside it rather than creating a second 16:9 box. */}
      <div className={`live-player__video${idle ? ' live-player__video--idle' : ''}`}>
        {!idle && source ? (
          <iframe
            key={source.url}
            ref={frameRef}
            className="ppv-player__frame"
            src={source.url}
            title={event.title}
            sandbox={PPV_IFRAME_SANDBOX}
            allow={PPV_IFRAME_ALLOW}
            allowFullScreen
            referrerPolicy={PPV_IFRAME_REFERRER_POLICY}
            onLoad={() => {
              documentLoaded.current.add(index);
              setIframeTrace((current) => ({
                ...current,
                iframeDocumentLoaded: true,
                loadEventAt: Date.now(),
              }));
              setFailover((current) => ({
                ...current,
                attempts: current.attempts.map((entry) =>
                  entry.index === index ? { ...entry, documentLoaded: true } : entry,
                ),
              }));
            }}
          />
        ) : (
          <div className="live-player__idle-message">
            {loading ? (
              <LoaderCircle className="spin" />
            ) : showWatch || showInfo ? (
              <ExternalLink />
            ) : (
              <Tv />
            )}
            <strong>{idleTitle}</strong>
            <span>{idleHint}</span>
            <div className="ppv-player__idle-actions">
              {exhausted && (
                <button type="button" onClick={retrySources} aria-label="Retry PPV sources">
                  <RotateCw />
                  Retry sources
                </button>
              )}
              {showWatch && (
                <a
                  className="ppv-player__official"
                  href={officialWatchUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open official provider
                </a>
              )}
              {showInfo && (
                <a
                  className="ppv-player__official"
                  href={officialInfoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open official page
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="live-player__meta">
        <span className={`live-badge${event.status === 'live' ? '' : ' live-badge--idle'}`}>
          <Radio />
          {event.status === 'live' ? 'LIVE' : event.category.toUpperCase()}
        </span>
        <div>
          <h2>{event.title}</h2>
          <p>
            {formatPpvStart(event.startsAt)}
            {sourceLabel ? ` · ${sourceLabel}` : ''}
            {sources.length > 1 ? ` · ${sources.length} sources` : ''}
          </p>
        </div>
        <div className="ppv-player__actions">
          {sources.length > 1 && (
            <button type="button" onClick={nextSource} aria-label="Next PPV source">
              <SkipForward />
              Source {index + 1}/{sources.length}
            </button>
          )}
          <button type="button" onClick={() => runLoad(eventRef.current)} aria-label="Reload PPV embeds">
            <RotateCw />
            Reload
          </button>
        </div>
      </div>
      {debugEnabled && (
        <PpvDiagnosticsPanel
          catalog={catalogDiagnostics ?? null}
          event={diagnostics ?? emptyEventDiagnostics(event.providerEventId)}
          iframe={iframeTrace}
          failover={failover}
          eventId={event.providerEventId}
          provenance={event.catalogProvenance ?? null}
          officialWatchAvailable={Boolean(officialWatchUrl)}
          officialInfoAvailable={Boolean(officialInfoUrl)}
          sourceIndex={sources.length ? index + 1 : 0}
          sourceCount={sources.length}
        />
      )}
    </div>
  );
}
