import { useState } from 'react';
import { ClipboardCopy } from 'lucide-react';
import {
  PPV_IFRAME_PROBE_MS,
  PPV_SOURCE_LOAD_DEADLINE_MS,
  serializePpvDiagnostics,
  type PpvCatalogDiagnostics,
  type PpvCatalogEndpointDiagnostics,
  type PpvCatalogProviderDiagnostics,
  type PpvEventCatalogProvenance,
  type PpvEventDiagnostics,
  type PpvFailoverDiagnostics,
  type PpvProviderDiagnostics,
  type PpvIframeDiagnostics,
} from '../lib/ppvDiagnostics';

/*
 * One debug surface for the whole PPV chain. Catalog diagnostics render even
 * when no event exists to select - a catalog that never loaded is exactly the
 * case where a player-only panel could never appear.
 */
interface PpvDiagnosticsPanelProps {
  catalog?: PpvCatalogDiagnostics | null;
  event?: PpvEventDiagnostics | null;
  iframe?: PpvIframeDiagnostics | null;
  failover?: PpvFailoverDiagnostics | null;
  /* Present only when an event is selected; gates the playback sections. */
  eventId?: string;
  provenance?: PpvEventCatalogProvenance | null;
  officialWatchAvailable?: boolean;
  sourceIndex?: number;
  sourceCount?: number;
}

type CopyState = 'idle' | 'copying' | 'copied' | 'copy_failed';

const COPY_LABEL: Record<CopyState, string> = {
  idle: 'Copy diagnostics',
  copying: 'Copying...',
  copied: 'Copied',
  copy_failed: 'Copy failed',
};

function Row({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div className="ppv-diag__row">
      <span>{label}</span>
      <strong>{String(value)}</strong>
    </div>
  );
}

function EndpointRows({ label, endpoint }: { label: string; endpoint: PpvCatalogEndpointDiagnostics }) {
  return (
    <>
      <Row label={`${label} status`} value={endpoint.status} />
      <Row label={`${label} HTTP`} value={endpoint.httpStatus ?? 'none'} />
      <Row label={`${label} rows`} value={endpoint.rowCount} />
    </>
  );
}

/*
 * One block per catalog provider. A single overall status cannot say which
 * provider answered - and "one of them answered" is the difference between a
 * usable catalog and a dead PPV tab.
 */
function CatalogProviderRows({ provider }: { provider: PpvCatalogProviderDiagnostics }) {
  return (
    <div className="ppv-diag__group">
      <h4>Catalog · {provider.providerId}</h4>
      <Row label="status" value={provider.status} />
      <Row label="requests" value={provider.requestCount} />
      <Row label="completed" value={provider.completedRequests} />
      <Row label="http statuses" value={provider.httpStatuses.join(', ') || 'none'} />
      <Row label="returned rows" value={provider.returnedRowCount} />
      <Row label="admitted events" value={provider.admittedEvents} />
      <Row label="rejected non-combat" value={provider.rejectedNonCombat} />
      <Row label="malformed rows" value={provider.malformedRowCount} />
      {provider.endpoints.map((endpoint, position) => (
        <Row
          key={`${endpoint.name ?? position}`}
          label={`endpoint ${endpoint.name ?? position}`}
          value={`${endpoint.status} · ${endpoint.httpStatus ?? 'no http'} · ${endpoint.rowCount} rows`}
        />
      ))}
    </div>
  );
}

/*
 * Any playback provider beyond the two that have named blocks below. The
 * registry is meant to grow; the panel must not need a new hand-written
 * section every time it does.
 */
function PlaybackProviderRows({ provider }: { provider: PpvProviderDiagnostics }) {
  return (
    <div className="ppv-diag__group">
      <h4>{provider.provider}</h4>
      <Row label="lookup state" value={provider.lookupState ?? 'pending'} />
      <Row label="provider-native id" value={provider.providerNativeIdentityAvailable ?? false} />
      <Row label="requests" value={provider.requestCount} />
      <Row label="completed" value={provider.completedRequests} />
      <Row label="returned rows" value={provider.returnedSourceCount} />
      <Row label="accepted" value={provider.acceptedEmbedCount} />
      <Row label="rejected" value={provider.rejectedEmbedCount} />
      <Row label="rejected hosts" value={provider.rejectedHosts.join(', ') || 'none'} />
      {provider.lookupState === 'not_attempted_unsupported' && (
        <p className="ppv-diag__warn">
          Not requested: this event carries nothing this provider can resolve, or this origin
          cannot host it. A skipped lookup, not a provider failure.
        </p>
      )}
    </div>
  );
}

export function PpvDiagnosticsPanel({
  catalog,
  event,
  iframe,
  failover,
  eventId,
  provenance,
  officialWatchAvailable,
  sourceIndex = 0,
  sourceCount = 0,
}: PpvDiagnosticsPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [fallbackText, setFallbackText] = useState('');

  const streamed = event?.streamed;
  const sportsrc = event?.sportsrc;
  const playback = Boolean(eventId);
  const secondsSinceMount =
    !iframe || iframe.mountedAt === null
      ? 0
      : Math.max(0, Math.round((Date.now() - iframe.mountedAt) / 1000));

  /*
   * Reporting "Copied" before the clipboard promise settles is worse than
   * useless on a phone, where the write is the part most likely to fail.
   */
  const onCopy = () => {
    const payload = serializePpvDiagnostics({
      catalog: catalog ?? null,
      catalogProvenance: provenance ?? null,
      event: event ?? null,
      iframe: iframe ?? null,
      failover: failover ?? null,
      officialWatchAvailable: officialWatchAvailable ?? false,
      sourceIndex,
      sourceCount,
    });
    setCopyState('copying');
    setFallbackText('');
    try {
      const write = navigator?.clipboard?.writeText;
      if (typeof write !== 'function') {
        setCopyState('copy_failed');
        setFallbackText(payload);
        return;
      }
      void Promise.resolve(navigator.clipboard.writeText(payload)).then(
        () => setCopyState('copied'),
        () => {
          setCopyState('copy_failed');
          setFallbackText(payload);
        },
      );
    } catch {
      setCopyState('copy_failed');
      setFallbackText(payload);
    }
  };

  return (
    <section className="ppv-diag" aria-label="PPV runtime diagnostics">
      <header>
        <strong>PPV Runtime Diagnostics</strong>
        <button type="button" onClick={onCopy} aria-label="Copy diagnostics">
          <ClipboardCopy />
          {COPY_LABEL[copyState]}
        </button>
      </header>

      <div className="ppv-diag__group">
        <h4>Catalog</h4>
        {catalog ? (
          <>
            <Row label="overall" value={catalog.overallStatus} />
            <Row label="normalized events" value={catalog.normalizedEvents} />
            <Row
              label="providers answering"
              value={(catalog.contributingProviders ?? []).join(', ') || 'none'}
            />
            <Row label="providers failed" value={(catalog.failedProviders ?? []).join(', ') || 'none'} />
            <Row label="merged duplicates" value={catalog.mergedDuplicates ?? 0} />
            <Row label="served from cache" value={catalog.fromCache ?? false} />
            <Row label="stale" value={catalog.stale ?? false} />
            <Row
              label="cache age (s)"
              value={
                catalog.cacheAgeMs == null ? 'n/a' : Math.round(catalog.cacheAgeMs / 1000)
              }
            />
            <EndpointRows label="fight" endpoint={catalog.fight} />
            <EndpointRows label="live" endpoint={catalog.live} />
            <EndpointRows label="today" endpoint={catalog.today} />
          </>
        ) : (
          <Row label="overall" value="pending" />
        )}
      </div>

      {(catalog?.providers ?? []).map((provider) => (
        <CatalogProviderRows key={provider.providerId} provider={provider} />
      ))}

      {playback && (
        <>
          <div className="ppv-diag__group">
            <h4>Event</h4>
            <Row label="event" value={eventId ?? 'none'} />
            <Row label="final state" value={event?.finalState ?? 'pending'} />
            <Row label="accepted embeds" value={event?.acceptedEmbedCount ?? 0} />
            <Row
              label="official provider link"
              value={officialWatchAvailable ?? event?.officialWatchAvailable ?? false}
            />
            <Row
              label="catalog providers"
              value={(provenance?.providers ?? []).join(', ') || 'unknown'}
            />
            <Row label="catalog feeds" value={(provenance?.feeds ?? []).join(', ') || 'unknown'} />
            <Row
              label="upstream categories"
              value={(provenance?.upstreamCategories ?? []).join(', ') || 'none'}
            />
          </div>

          <div className="ppv-diag__group">
            <h4>Streamed</h4>
            <Row label="requests" value={streamed?.requestCount ?? 0} />
            <Row label="completed" value={streamed?.completedRequests ?? 0} />
            <Row label="timeouts" value={streamed?.timeoutCount ?? 0} />
            <Row label="network/CORS" value={streamed?.networkErrorCount ?? 0} />
            <Row label="http errors" value={streamed?.httpErrorCount ?? 0} />
            <Row label="http statuses" value={(streamed?.httpStatuses ?? []).join(', ') || 'none'} />
            <Row label="returned rows" value={streamed?.returnedSourceCount ?? 0} />
            <Row label="malformed rows" value={streamed?.malformedRowCount ?? 0} />
            <Row label="accepted" value={streamed?.acceptedEmbedCount ?? 0} />
            <Row label="rejected" value={streamed?.rejectedEmbedCount ?? 0} />
            <Row label="rejected hosts" value={(streamed?.rejectedHosts ?? []).join(', ') || 'none'} />
            <Row label="reject reasons" value={(streamed?.rejectionReasons ?? []).join(', ') || 'none'} />
          </div>

          <div className="ppv-diag__group">
            <h4>SportSRC</h4>
            <Row label="lookup state" value={sportsrc?.lookupState ?? 'pending'} />
            <Row
              label="provider-native id"
              value={sportsrc?.providerNativeIdentityAvailable ?? false}
            />
            <Row label="requests" value={sportsrc?.requestCount ?? 0} />
            <Row label="category" value={sportsrc?.requestedCategory ?? 'n/a'} />
            <Row label="completed" value={sportsrc?.completedRequests ?? 0} />
            <Row label="timeouts" value={sportsrc?.timeoutCount ?? 0} />
            <Row label="network/CORS" value={sportsrc?.networkErrorCount ?? 0} />
            <Row label="http statuses" value={(sportsrc?.httpStatuses ?? []).join(', ') || 'none'} />
            <Row label="success flag" value={String(sportsrc?.responseSuccessFlag ?? 'n/a')} />
            <Row label="provider reported no result" value={sportsrc?.providerReportedUnsuccessful ?? false} />
            <Row label="has data" value={sportsrc?.hasData ?? false} />
            <Row label="has sources" value={sportsrc?.hasSources ?? false} />
            <Row label="malformed responses" value={sportsrc?.malformedResponseCount ?? 0} />
            <Row label="returned rows" value={sportsrc?.returnedSourceCount ?? 0} />
            <Row label="accepted" value={sportsrc?.acceptedEmbedCount ?? 0} />
            <Row label="rejected" value={sportsrc?.rejectedEmbedCount ?? 0} />
            <Row label="rejected hosts" value={(sportsrc?.rejectedHosts ?? []).join(', ') || 'none'} />
            {sportsrc?.lookupState === 'not_attempted_unmapped' && (
              <p className="ppv-diag__warn">
                Not requested: no SportSRC-native event identity for this event. This is a skipped
                lookup, not a provider failure.
              </p>
            )}
          </div>

          {(event?.providers ?? [])
            .filter((provider) => provider.stage !== 'streamed' && provider.stage !== 'sportsrc')
            .map((provider) => (
              <PlaybackProviderRows key={provider.stage} provider={provider} />
            ))}

          <div className="ppv-diag__group">
            <h4>Iframe</h4>
            <Row label="mounted" value={iframe?.mounted ?? false} />
            <Row label="hostname" value={iframe?.hostname || 'none'} />
            <Row label="document load event" value={iframe?.iframeDocumentLoaded ? 'yes' : 'no'} />
            <Row label="seconds since mounted" value={iframe?.mounted ? secondsSinceMount : 0} />
            <Row
              label={`present after ${Math.round(PPV_IFRAME_PROBE_MS / 1000)}s`}
              value={
                !iframe || iframe.presentAfterProbe === null ? 'pending' : iframe.presentAfterProbe
              }
            />
            <Row label="source" value={sourceCount ? `${sourceIndex}/${sourceCount}` : '0/0'} />
            <Row label="frame error event" value={iframe?.loadErrorEvent ?? false} />
            <p className="ppv-diag__warn">
              A document load event only means the frame document loaded. It is not proof of playback.
            </p>
          </div>

          <div className="ppv-diag__group">
            <h4>Failover</h4>
            <Row label="sources" value={failover?.sourceCount ?? sourceCount} />
            <Row label="current index" value={(failover?.currentIndex ?? 0) + 1} />
            <Row label="attempts" value={failover?.attempts.length ?? 0} />
            <Row label="exhausted" value={failover?.exhausted ?? false} />
            {(failover?.attempts ?? []).map((attempt) => (
              <Row
                key={attempt.index}
                label={`attempt ${attempt.index + 1}`}
                value={`${attempt.providerId} · ${attempt.hostname || 'none'} · ${
                  attempt.documentLoaded ? 'document loaded' : 'no load event'
                }${attempt.advanced ? ` · advanced: ${attempt.advanceReason ?? 'unknown'}` : ''}`}
              />
            ))}
            <p className="ppv-diag__warn">
              Advancing is driven by a frame error event or by no load event inside{' '}
              {Math.round(PPV_SOURCE_LOAD_DEADLINE_MS / 1000)}s. Neither says whether video played.
            </p>
          </div>
        </>
      )}

      {copyState === 'copy_failed' && fallbackText && (
        <textarea
          className="ppv-diag__fallback"
          aria-label="Diagnostics text"
          readOnly
          value={fallbackText}
        />
      )}
    </section>
  );
}
