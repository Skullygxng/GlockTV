/*
 * PPV runtime diagnostics.
 *
 * Everything here stays local and in-memory: nothing is transmitted anywhere.
 * Diagnostics are sanitized by construction — only counts, enum labels and bare
 * hostnames are ever recorded. Full embed URLs, paths, query strings and any
 * credential-bearing values must never reach these structures, and
 * sanitizePpvDiagnostics is a second line of defence before anything is shown
 * or copied.
 */

export type PpvDiagnosticStage =
  | 'catalog'
  | 'catalog_provider'
  | 'streamed'
  | 'sportsrc'
  | 'youtube'
  | 'twitch'
  | 'policy'
  | 'iframe'
  | 'failover';

/*
 * Catalog and playback are separate provider populations with separate failure
 * modes. A catalog provider answering "no events" says nothing about whether a
 * stream can be played, and a playback provider failing says nothing about
 * whether the event exists - so they never share an identifier space.
 */
export type PpvCatalogProviderId = 'streamed' | 'thesportsdb';
export type PpvPlaybackProviderId = 'streamed' | 'sportsrc' | 'youtube' | 'twitch';

export type PpvCatalogFeed = 'fight' | 'live' | 'today';

/*
 * Which catalog feeds actually contributed a normalized event, and the
 * upstream category labels they carried. Recorded because the diagnostics so
 * far reported only per-feed row counts, which cannot say which feed
 * introduced any particular event - the question the catalog defect turns on.
 *
 * Labels only: no titles, no source refs, no response bodies, no URLs.
 */
export interface PpvEventCatalogProvenance {
  feeds: PpvCatalogFeed[];
  upstreamCategories: string[];
  /*
   * Which catalog providers contributed this event. Set by the aggregator, so
   * a single-provider load leaves it absent rather than asserting a merge that
   * never happened.
   */
  providers?: PpvCatalogProviderId[];
}

/*
 * Upstream categories are short provider labels. Anything that is not a plain
 * short label is dropped rather than rendered, so an unexpected response can
 * never push arbitrary text into the panel or the copy payload.
 */
const CATEGORY_LABEL = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

export function sanitizeUpstreamCategory(value: unknown): string {
  if (typeof value !== 'string') return '';
  const label = value.trim().toLowerCase();
  return CATEGORY_LABEL.test(label) ? label : '';
}

/*
 * A backup provider we never had a native identity for was not requested at
 * all. That is not a provider failure and must never be reported as one.
 */
export type PpvProviderLookupState =
  | 'not_attempted_unmapped'
  | 'not_attempted_unsupported'
  | 'attempted';

export type PpvRequestStatus =
  | 'success'
  | 'empty_success'
  | 'http_error'
  | 'network_or_cors_error'
  | 'timeout'
  | 'malformed';

/*
 * One entry per catalog endpoint. Collapsing a failed endpoint into an empty
 * array made "returned nothing" indistinguishable from "never answered", which
 * is exactly the ambiguity a real-device run has to resolve.
 */
export interface PpvCatalogEndpointDiagnostics {
  status: PpvRequestStatus;
  httpStatus: number | null;
  rowCount: number;
  /* Short enum-ish label for the endpoint, never a URL. */
  name?: string;
}

/*
 * One entry per catalog provider. The aggregator needs to be able to say
 * "thesportsdb answered, streamed did not" - a single overall status cannot,
 * and that ambiguity is what made a total PPV failure unreadable.
 */
/*
 * How much of the window a provider was asked about actually came back.
 *
 *   complete - every expected request answered
 *   partial  - some answered, some did not
 *   none     - nothing answered
 *
 * This is separate from status on purpose. A provider that answered one day of
 * a five-day window and failed the other four still reports empty_success for
 * the day it saw, and treating that as authoritative evidence that the whole
 * upcoming catalog is empty is how a good cached list got thrown away.
 */
export type PpvCatalogCoverage = 'complete' | 'partial' | 'none';

export interface PpvCatalogProviderDiagnostics {
  stage: 'catalog_provider';
  providerId: PpvCatalogProviderId;
  status: PpvRequestStatus;
  coverage: PpvCatalogCoverage;
  endpoints: PpvCatalogEndpointDiagnostics[];
  requestCount: number;
  completedRequests: number;
  httpStatuses: number[];
  /* Rows the provider returned, before combat-only admission. */
  returnedRowCount: number;
  admittedEvents: number;
  rejectedNonCombat: number;
  malformedRowCount: number;
}

export function emptyCatalogProviderDiagnostics(
  providerId: PpvCatalogProviderId,
): PpvCatalogProviderDiagnostics {
  return {
    stage: 'catalog_provider',
    providerId,
    status: 'empty_success',
    coverage: 'complete',
    endpoints: [],
    requestCount: 0,
    completedRequests: 0,
    httpStatuses: [],
    returnedRowCount: 0,
    admittedEvents: 0,
    rejectedNonCombat: 0,
    malformedRowCount: 0,
  };
}

export interface PpvCatalogDiagnostics {
  stage: 'catalog';
  startedAt: number;
  completedAt: number;
  fight: PpvCatalogEndpointDiagnostics;
  live: PpvCatalogEndpointDiagnostics;
  today: PpvCatalogEndpointDiagnostics;
  normalizedEvents: number;
  overallStatus: PpvRequestStatus;
  /*
   * Aggregate fields. Optional so a single-provider load (loadPpvCatalog) can
   * keep reporting exactly what it always did; the aggregator fills them in.
   */
  providers?: PpvCatalogProviderDiagnostics[];
  contributingProviders?: PpvCatalogProviderId[];
  failedProviders?: PpvCatalogProviderId[];
  mergedDuplicates?: number;
  /*
   * At least one contributing provider answered only part of the window it was
   * asked about, so this result is not authoritative about what does not
   * appear in it.
   */
  partialCoverage?: boolean;
  /* True when a cached catalog contributed events to this result. */
  fromCache?: boolean;
  stale?: boolean;
  cacheAgeMs?: number | null;
}

export interface PpvProviderDiagnostics {
  stage: PpvPlaybackProviderId;
  provider: string;
  requestCount: number;
  completedRequests: number;
  timeoutCount: number;
  networkErrorCount: number;
  httpErrorCount: number;
  httpStatuses: number[];
  malformedResponseCount: number;
  returnedSourceCount: number;
  malformedRowCount: number;
  acceptedEmbedCount: number;
  rejectedEmbedCount: number;
  /* Hostnames only — never a path or query string. */
  rejectedHosts: string[];
  rejectionReasons: string[];
  /* SportSRC only. */
  requestedCategory?: string;
  responseSuccessFlag?: boolean | null;
  hasData?: boolean;
  hasSources?: boolean;
  /*
   * Whether this provider had an identifier of its own for the event. An ID
   * issued by another provider is not evidence of the same event here, so
   * without a native one the lookup is skipped rather than guessed.
   */
  providerNativeIdentityAvailable?: boolean;
  lookupState?: PpvProviderLookupState;
  /*
   * The provider answered with a well-formed body that reports no result.
   * That is an unsuccessful lookup, not a malformed response.
   */
  providerReportedUnsuccessful?: boolean;
}

export type PpvEventFinalState =
  | 'playable_candidate'
  /*
   * No inline source resolved, but the event carries a validated official
   * provider link. That is a real outcome, not an error - it must never be
   * reported as an embed failure.
   */
  | 'official_only'
  /*
   * No inline source and no watch destination, but the event does carry the
   * promotion's own information page. Distinct from official_only: an
   * information page is not somewhere the event can be watched.
   */
  | 'official_info_only'
  | 'unavailable'
  | 'provider_failure'
  | 'policy_rejected'
  | 'timeout'
  | 'malformed';

export interface PpvEventDiagnostics {
  eventId: string;
  acceptedEmbedCount: number;
  finalState: PpvEventFinalState;
  /* The two original providers, kept as named fields for existing callers. */
  streamed: PpvProviderDiagnostics;
  sportsrc: PpvProviderDiagnostics;
  /*
   * Every playback provider that was consulted, in registry order. streamed
   * and sportsrc appear here too - they are the same objects, not copies - so
   * the registry can grow without the panel needing a new named field each
   * time.
   */
  providers?: PpvProviderDiagnostics[];
  /*
   * Whether the event carries a destination the provider explicitly calls a
   * place to watch, and separately whether it carries a promotion information
   * page. They are not interchangeable and are never collapsed into one flag.
   */
  officialWatchAvailable?: boolean;
  officialInfoAvailable?: boolean;
}

/*
 * Why the player moved off a source. Only signals a cross-origin frame can
 * actually produce: an error event, the absence of any load event inside the
 * deadline, or an explicit user action. Nothing here is a playback signal.
 */
export type PpvAdvanceReason =
  | 'iframe_error_event'
  | 'no_load_event_within_deadline'
  | 'user_requested';

export interface PpvSourceAttemptDiagnostics {
  index: number;
  providerId: string;
  /* Hostname only. */
  hostname: string;
  documentLoaded: boolean;
  advanced: boolean;
  advanceReason: PpvAdvanceReason | null;
}

export interface PpvFailoverDiagnostics {
  stage: 'failover';
  sourceCount: number;
  currentIndex: number;
  attempts: PpvSourceAttemptDiagnostics[];
  /* Every source has been mounted once and none produced a load event. */
  exhausted: boolean;
}

export function emptyFailoverDiagnostics(): PpvFailoverDiagnostics {
  return { stage: 'failover', sourceCount: 0, currentIndex: 0, attempts: [], exhausted: false };
}

/*
 * How long a source is given to produce a document load event before the
 * player moves on. Long enough for a slow mobile network to answer, short
 * enough that a dead source does not strand the viewer. Absence of a load
 * event is the only load failure a cross-origin frame reliably exposes.
 */
export const PPV_SOURCE_LOAD_DEADLINE_MS = 12_000;

/*
 * A cross-origin iframe load event only proves the frame document loaded. It
 * says nothing about whether video is playing, so no field here is named or
 * worded as playback success.
 */
export interface PpvIframeDiagnostics {
  stage: 'iframe';
  mounted: boolean;
  hostname: string;
  mountedAt: number | null;
  loadEventAt: number | null;
  iframeDocumentLoaded: boolean;
  /* The frame fired an error event. Still not a playback signal either way. */
  loadErrorEvent: boolean;
  presentAfterProbe: boolean | null;
  unmountedBeforeProbe: boolean;
}

export const PPV_IFRAME_PROBE_MS = 5000;

export function emptyProviderDiagnostics(
  stage: PpvPlaybackProviderId,
  provider: string,
): PpvProviderDiagnostics {
  return {
    stage,
    provider,
    requestCount: 0,
    completedRequests: 0,
    timeoutCount: 0,
    networkErrorCount: 0,
    httpErrorCount: 0,
    httpStatuses: [],
    malformedResponseCount: 0,
    returnedSourceCount: 0,
    malformedRowCount: 0,
    acceptedEmbedCount: 0,
    rejectedEmbedCount: 0,
    rejectedHosts: [],
    rejectionReasons: [],
  };
}

export function emptyEventDiagnostics(eventId: string): PpvEventDiagnostics {
  const streamed = emptyProviderDiagnostics('streamed', 'streamed');
  const sportsrc = emptyProviderDiagnostics('sportsrc', 'sportsrc');
  return {
    eventId,
    acceptedEmbedCount: 0,
    finalState: 'unavailable',
    streamed,
    sportsrc,
  };
}

export function emptyIframeDiagnostics(): PpvIframeDiagnostics {
  return {
    stage: 'iframe',
    mounted: false,
    hostname: '',
    mountedAt: null,
    loadEventAt: null,
    iframeDocumentLoaded: false,
    loadErrorEvent: false,
    presentAfterProbe: null,
    unmountedBeforeProbe: false,
  };
}

/* Hostname only. Returns '' when the value is not a parseable URL. */
export function diagnosticHostname(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isPpvDebugEnabled(search?: string): boolean {
  try {
    const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);
    return new URLSearchParams(query).get('ppvdebug') === '1';
  } catch {
    return false;
  }
}

/*
 * Defence in depth. Diagnostics should already be free of URLs, but anything
 * that looks like a location, query string or credential is redacted before it
 * can be rendered or copied. Bare hostnames survive.
 */
const UNSAFE_STRING =
  /(:\/\/|^\/|\/|\?|&|=|token|authoriz|cookie|bearer|secret|signature|password|session)/i;

export function sanitizeDiagnosticString(value: string): string {
  return UNSAFE_STRING.test(value) ? '[redacted]' : value;
}

export function sanitizePpvDiagnostics<T>(value: T): T {
  if (typeof value === 'string') return sanitizeDiagnosticString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => sanitizePpvDiagnostics(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = sanitizePpvDiagnostics(item);
    }
    return next as unknown as T;
  }
  return value;
}

export function serializePpvDiagnostics(value: unknown): string {
  return JSON.stringify(sanitizePpvDiagnostics(value), null, 2);
}
