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

export type PpvDiagnosticStage = 'catalog' | 'streamed' | 'sportsrc' | 'policy' | 'iframe';

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
export type PpvProviderLookupState = 'not_attempted_unmapped' | 'attempted';

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
}

export interface PpvProviderDiagnostics {
  stage: 'streamed' | 'sportsrc';
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
  | 'unavailable'
  | 'provider_failure'
  | 'policy_rejected'
  | 'timeout'
  | 'malformed';

export interface PpvEventDiagnostics {
  eventId: string;
  acceptedEmbedCount: number;
  finalState: PpvEventFinalState;
  streamed: PpvProviderDiagnostics;
  sportsrc: PpvProviderDiagnostics;
}

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
  presentAfterProbe: boolean | null;
  unmountedBeforeProbe: boolean;
}

export const PPV_IFRAME_PROBE_MS = 5000;

export function emptyProviderDiagnostics(
  stage: 'streamed' | 'sportsrc',
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
  return {
    eventId,
    acceptedEmbedCount: 0,
    finalState: 'unavailable',
    streamed: emptyProviderDiagnostics('streamed', 'streamed'),
    sportsrc: emptyProviderDiagnostics('sportsrc', 'sportsrc'),
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
