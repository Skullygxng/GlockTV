import { inspectPpvEmbedUrl, isAllowedPpvEmbedUrl } from './ppvEmbedPolicy';
import {
  emptyEventDiagnostics,
  emptyProviderDiagnostics,
  sanitizeUpstreamCategory,
  type PpvCatalogFeed,
  type PpvEventCatalogProvenance,
  type PpvCatalogDiagnostics,
  type PpvCatalogEndpointDiagnostics,
  type PpvEventDiagnostics,
  type PpvProviderDiagnostics,
  type PpvRequestStatus,
} from './ppvDiagnostics';

export type PpvCategory = 'boxing' | 'mma' | 'wrestling' | 'other';
export type PpvStatus = 'upcoming' | 'live' | 'ended';
export type PpvProviderId = 'streamed' | 'sportsrc';

export interface PpvEmbed {
  provider: PpvProviderId;
  id?: string;
  source?: string;
  language?: string;
  hd?: boolean;
  url: string;
}

/*
 * Identifiers are provider-native. An ID issued by one provider is not
 * evidence that another provider knows the same event by it - real-device runs
 * showed a Streamed ID 404ing at SportSRC for some events and coincidentally
 * resolving for others - so each provider only ever gets its own.
 */
export interface PpvEventProviderRefs {
  streamed?: { eventId: string };
  sportsrc?: { eventId: string; category?: string };
}

export interface PpvEvent {
  provider: PpvProviderId;
  /* Streamed's identifier. Retained for catalog keys and existing callers. */
  providerEventId: string;
  providerRefs?: PpvEventProviderRefs;
  /* Which catalog feeds contributed this event. Sanitized labels only. */
  catalogProvenance?: PpvEventCatalogProvenance;
  title: string;
  category: PpvCategory;
  promotion?: string;
  participants?: string[];
  startsAt: string;
  status: PpvStatus;
  poster?: string;
  sourceRefs: { source: string; id: string }[];
  embeds: PpvEmbed[];
}

export interface PpvCatalog {
  events: PpvEvent[];
  source: 'streamed';
  loadedAt: string;
  /* Sanitized counts only; see ppvDiagnostics. */
  diagnostics?: PpvCatalogDiagnostics;
}

export const STREAMED_API = 'https://streamed.pk';
export const SPORTSRC_API = 'https://api.sportsrc.org';

const STALE_BEFORE_MS = 12 * 60 * 60 * 1000;
const LIVE_WINDOW_BEFORE_MS = 15 * 60 * 1000;
const LIVE_WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;

type FetchLike = typeof fetch;

interface StreamedTeam {
  name?: string | null;
  badge?: string | null;
}

interface StreamedMatch {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  date?: unknown;
  poster?: unknown;
  popular?: unknown;
  teams?: { home?: StreamedTeam; away?: StreamedTeam } | null;
  sources?: { source?: unknown; id?: unknown }[] | null;
}

interface StreamedStream {
  id?: unknown;
  streamNo?: unknown;
  language?: unknown;
  hd?: unknown;
  embedUrl?: unknown;
  source?: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* Single gate for every provider-supplied embed URL. See ppvEmbedPolicy. */
export function isHostedEmbedUrl(value: string): boolean {
  return isAllowedPpvEmbedUrl(value);
}

export function classifyPpvCategory(title: string, id = ''): PpvCategory {
  const haystack = `${title} ${id}`.toLowerCase();
  if (/\b(wwe|aew|njpw|impact|tna|wrestling|smackdown|raw|collision|nxt)\b/.test(haystack)) {
    return 'wrestling';
  }
  if (/\b(box|boxing|dazn|matchroom)\b/.test(haystack)) return 'boxing';
  if (/\b(ufc|mma|lfa|pfl|bellator|one friday|one championship|contender series|road to ufc)\b/.test(haystack)) {
    return 'mma';
  }
  return 'other';
}

export function inferPromotion(title: string): string | undefined {
  const haystack = title.toLowerCase();
  if (haystack.includes('ufc')) return 'UFC';
  if (haystack.includes('wwe')) return 'WWE';
  if (haystack.includes('aew')) return 'AEW';
  if (haystack.includes('lfa')) return 'LFA';
  if (haystack.includes('pfl')) return 'PFL';
  if (haystack.includes('one friday') || haystack.includes('one championship')) return 'ONE';
  if (haystack.includes('boxing')) return 'Boxing';
  return undefined;
}

export function derivePpvStatus(startsAtMs: number, now = Date.now(), liveIds?: Set<string>, eventId?: string): PpvStatus {
  if (eventId && liveIds?.has(eventId)) return 'live';
  if (startsAtMs > now + LIVE_WINDOW_BEFORE_MS) return 'upcoming';
  if (startsAtMs >= now - LIVE_WINDOW_AFTER_MS) return 'live';
  return 'ended';
}

export function streamedPosterUrl(poster: unknown): string | undefined {
  const value = asString(poster);
  if (!value) return undefined;
  if (value.startsWith('https://')) return value;
  if (value.startsWith('/')) return `${STREAMED_API}${value}`;
  return `${STREAMED_API}/api/images/proxy/${value}.webp`;
}

function participantsFrom(match: StreamedMatch, title: string): string[] | undefined {
  const home = asString(match.teams?.home?.name);
  const away = asString(match.teams?.away?.name);
  if (home && away) return [home, away];
  const vs = title.split(/\s+vs\.?\s+/i).map((part) => part.trim()).filter(Boolean);
  return vs.length === 2 ? vs : undefined;
}

export function mapStreamedMatch(
  match: StreamedMatch,
  liveIds?: Set<string>,
  now = Date.now(),
  catalogProvenance?: PpvEventCatalogProvenance,
): PpvEvent | null {
  const id = asString(match.id);
  const title = asString(match.title);
  const date = asNumber(match.date);
  if (!id || !title || date == null) return null;
  if (date < now - STALE_BEFORE_MS && !liveIds?.has(id)) return null;

  const sources = (match.sources ?? [])
    .map((source) => ({ source: asString(source.source), id: asString(source.id) }))
    .filter((source) => source.source && source.id);

  return {
    provider: 'streamed',
    providerEventId: id,
    providerRefs: { streamed: { eventId: id } },
    catalogProvenance,
    title,
    category: classifyPpvCategory(title, id),
    promotion: inferPromotion(title),
    participants: participantsFrom(match, title),
    startsAt: new Date(date).toISOString(),
    status: derivePpvStatus(date, now, liveIds, id),
    poster: streamedPosterUrl(match.poster),
    sourceRefs: sources,
    embeds: [],
  };
}

/*
 * Provider order, deduped on first occurrence. There is no quality ranking by
 * source name: a real-device run played an `admin` source successfully while a
 * `golf` source returned a player error, so the names carry no health signal
 * and no documented provider contract defines an ordering.
 */
export function mergePpvEmbeds(embeds: PpvEmbed[]): PpvEmbed[] {
  const seen = new Set<string>();
  const next: PpvEmbed[] = [];
  for (const embed of embeds) {
    if (!isHostedEmbedUrl(embed.url)) continue;
    const key = embed.url.replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(embed);
  }
  return next;
}

/*
 * Bounded so one hung provider cannot pin the PPV UI. Mobile networks are slow,
 * but a hosted-embed lookup that has not answered within this window is not
 * going to, and the user still has backup providers to try.
 */
export const PPV_REQUEST_TIMEOUT_MS = 8000;
export const PPV_CATALOG_TIMEOUT_MS = 10000;

export class PpvHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Request failed (${httpStatus})`);
    this.name = 'PpvHttpError';
  }
}

export class PpvTimeoutError extends Error {
  constructor(url: string) {
    super(`PPV request timed out: ${url}`);
    this.name = 'PpvTimeoutError';
  }
}

/*
 * Aborts the in-flight request and still settles even if the caller's fetch
 * implementation ignores the abort signal, so a request can never leave the UI
 * loading forever.
 */
async function fetchJson(url: string, request: FetchLike, timeoutMs = PPV_REQUEST_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new PpvTimeoutError(url));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      request(url, { headers: { Accept: 'application/json' }, signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok) throw new PpvHttpError(response.status);
    return await Promise.race([response.json(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type PpvRequestOutcome =
  | { status: 'success'; data: unknown }
  | { status: 'http_error'; httpStatus: number }
  | { status: 'timeout' }
  | { status: 'network_or_cors_error' }
  | { status: 'malformed' };

/*
 * A browser fetch rejection is not proof of CORS specifically - it can also be
 * DNS, TLS or offline - so it is reported as network_or_cors_error rather than
 * being asserted as one cause.
 */
export function classifyPpvRequestError(reason: unknown): Exclude<PpvRequestOutcome, { status: 'success' }> {
  if (reason instanceof PpvTimeoutError) return { status: 'timeout' };
  if (reason instanceof PpvHttpError) return { status: 'http_error', httpStatus: reason.httpStatus };
  if (reason instanceof SyntaxError) return { status: 'malformed' };
  return { status: 'network_or_cors_error' };
}

export function ppvOutcomeStatus(outcome: PpvRequestOutcome): PpvRequestStatus {
  return outcome.status;
}

async function requestJson(
  url: string,
  request: FetchLike,
  timeoutMs = PPV_REQUEST_TIMEOUT_MS,
): Promise<PpvRequestOutcome> {
  try {
    return { status: 'success', data: await fetchJson(url, request, timeoutMs) };
  } catch (reason) {
    return classifyPpvRequestError(reason);
  }
}

function recordFailure(diagnostics: PpvProviderDiagnostics, outcome: PpvRequestOutcome): void {
  if (outcome.status === 'timeout') diagnostics.timeoutCount += 1;
  else if (outcome.status === 'network_or_cors_error') diagnostics.networkErrorCount += 1;
  else if (outcome.status === 'malformed') diagnostics.malformedResponseCount += 1;
  else if (outcome.status === 'http_error') {
    diagnostics.httpErrorCount += 1;
    if (!diagnostics.httpStatuses.includes(outcome.httpStatus)) {
      diagnostics.httpStatuses.push(outcome.httpStatus);
    }
  }
}

/* Records hostname and reason only - never the path or query. */
function recordRejection(diagnostics: PpvProviderDiagnostics, url: string): void {
  const inspection = inspectPpvEmbedUrl(url);
  diagnostics.rejectedEmbedCount += 1;
  if (inspection.hostname && !diagnostics.rejectedHosts.includes(inspection.hostname)) {
    diagnostics.rejectedHosts.push(inspection.hostname);
  }
  if (!diagnostics.rejectionReasons.includes(inspection.reason)) {
    diagnostics.rejectionReasons.push(inspection.reason);
  }
}

function asMatchList(value: unknown): StreamedMatch[] {
  return Array.isArray(value) ? value : [];
}

/* Prefer a present, richer value over a blank or thinner duplicate. */
function richerValue(base: unknown, next: unknown): unknown {
  const left = asString(base);
  const right = asString(next);
  if (!left) return right ? next : base;
  if (!right) return base;
  return right.length > left.length ? next : base;
}

function mergeSourceRefs(
  base: StreamedMatch['sources'],
  next: StreamedMatch['sources'],
): StreamedMatch['sources'] {
  const seen = new Set<string>();
  const merged: { source?: unknown; id?: unknown }[] = [];
  for (const row of [...(base ?? []), ...(next ?? [])]) {
    const source = asString(row?.source);
    const id = asString(row?.id);
    if (!source || !id) continue;
    const key = `${source}|${id}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

function hasTeamNames(match: StreamedMatch): boolean {
  return Boolean(asString(match.teams?.home?.name) || asString(match.teams?.away?.name));
}

/*
 * fight/live/today can each carry the same event at a different level of
 * detail. Merge field by field so a sparse later row cannot erase richer
 * metadata that an earlier row already supplied.
 */
export function mergeStreamedMatches(base: StreamedMatch, next: StreamedMatch): StreamedMatch {
  return {
    id: asString(base.id) ? base.id : next.id,
    title: richerValue(base.title, next.title),
    category: asString(base.category) ? base.category : next.category,
    date: asNumber(base.date) != null ? base.date : next.date,
    poster: asString(base.poster) ? base.poster : next.poster,
    popular: base.popular ?? next.popular,
    teams: hasTeamNames(base) ? base.teams : (next.teams ?? base.teams),
    sources: mergeSourceRefs(base.sources, next.sources),
  };
}

/*
 * Carries the sanitized catalog diagnostics through a rejection, so a catalog
 * that never produced an event can still say why. The message is deliberately
 * generic: request errors carry the requested URL in their own message, and
 * that must not reach the UI.
 */
export class PpvCatalogError extends Error {
  constructor(readonly diagnostics: PpvCatalogDiagnostics) {
    super('PPV events could not load.');
    this.name = 'PpvCatalogError';
  }
}

/*
 * A 200 carrying the wrong shape is malformed, an empty array is a real empty
 * answer, and every failure keeps its own class. rowCount is a count, never a
 * payload.
 */
function classifyCatalogEndpoint(outcome: PpvRequestOutcome): {
  diagnostics: PpvCatalogEndpointDiagnostics;
  rows: StreamedMatch[];
} {
  if (outcome.status !== 'success') {
    return {
      diagnostics: {
        status: outcome.status,
        httpStatus: outcome.status === 'http_error' ? outcome.httpStatus : null,
        rowCount: 0,
      },
      rows: [],
    };
  }
  if (!Array.isArray(outcome.data)) {
    return { diagnostics: { status: 'malformed', httpStatus: null, rowCount: 0 }, rows: [] };
  }
  return {
    diagnostics: {
      status: outcome.data.length ? 'success' : 'empty_success',
      httpStatus: null,
      rowCount: outcome.data.length,
    },
    rows: outcome.data as StreamedMatch[],
  };
}

export async function loadPpvCatalog(request: FetchLike = fetch): Promise<PpvCatalog> {
  const startedAt = Date.now();
  const [fightOutcome, liveOutcome, todayOutcome] = await Promise.all([
    requestJson(`${STREAMED_API}/api/matches/fight`, request, PPV_CATALOG_TIMEOUT_MS),
    requestJson(`${STREAMED_API}/api/matches/live`, request, PPV_CATALOG_TIMEOUT_MS),
    requestJson(`${STREAMED_API}/api/matches/all-today`, request, PPV_CATALOG_TIMEOUT_MS),
  ]);

  const fightEndpoint = classifyCatalogEndpoint(fightOutcome);
  const liveEndpoint = classifyCatalogEndpoint(liveOutcome);
  const todayEndpoint = classifyCatalogEndpoint(todayOutcome);

  // The fight feed stays required. A failed required feed still rejects, as it
  // always has - it just carries its diagnostics out now instead of being
  // downgraded to a successful empty catalog.
  if (fightOutcome.status !== 'success') {
    throw new PpvCatalogError({
      stage: 'catalog',
      startedAt,
      completedAt: Date.now(),
      fight: fightEndpoint.diagnostics,
      live: liveEndpoint.diagnostics,
      today: todayEndpoint.diagnostics,
      normalizedEvents: 0,
      overallStatus: fightEndpoint.diagnostics.status,
    });
  }

  // live and today keep degrading gracefully; their failures are now recorded
  // rather than becoming indistinguishable from a genuine empty response.
  const fight = fightEndpoint.rows;
  const live = liveEndpoint.rows;
  const today = todayEndpoint.rows;

  const liveMatches = asMatchList(live);
  const liveIds = new Set(liveMatches.map((match) => asString(match.id)).filter(Boolean));
  const merged = new Map<string, StreamedMatch>();

  /*
   * Admission is unchanged from production. Narrowing it needs evidence about
   * which feed actually introduces a wrongly-admitted event, and the row counts
   * reported so far cannot answer that - so this pass records provenance and
   * changes no behaviour.
   */
  const provenance = new Map<string, PpvEventCatalogProvenance>();
  const feeds: Array<[PpvCatalogFeed, StreamedMatch[]]> = [
    ['fight', asMatchList(fight)],
    ['live', liveMatches],
    ['today', asMatchList(today)],
  ];

  for (const [feed, rows] of feeds) {
    for (const match of rows) {
      const id = asString(match.id);
      const title = asString(match.title);
      if (!id || !title) continue;
      const category = asString(match.category);
      const combat =
        category === 'fight' ||
        classifyPpvCategory(title, id) !== 'other' ||
        /\bppv\b|fight/i.test(`${id} ${title}`);
      if (!combat) continue;

      // Only a row that was actually admitted counts as having contributed.
      const trail = provenance.get(id) ?? { feeds: [], upstreamCategories: [] };
      if (!trail.feeds.includes(feed)) trail.feeds.push(feed);
      const label = sanitizeUpstreamCategory(category);
      if (label && !trail.upstreamCategories.includes(label)) trail.upstreamCategories.push(label);
      provenance.set(id, trail);

      const existing = merged.get(id);
      merged.set(id, existing ? mergeStreamedMatches(existing, match) : match);
    }
  }

  const events = [...merged.entries()]
    .map(([id, match]) => mapStreamedMatch(match, liveIds, Date.now(), provenance.get(id)))
    .filter((event): event is PpvEvent => Boolean(event))
    .filter((event) => event.status !== 'ended')
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'live' ? -1 : 1;
      return Date.parse(left.startsAt) - Date.parse(right.startsAt);
    });

  return {
    events,
    source: 'streamed',
    loadedAt: new Date().toISOString(),
    diagnostics: {
      stage: 'catalog',
      startedAt,
      completedAt: Date.now(),
      fight: fightEndpoint.diagnostics,
      live: liveEndpoint.diagnostics,
      today: todayEndpoint.diagnostics,
      normalizedEvents: events.length,
      overallStatus: events.length
        ? 'success'
        : fightEndpoint.diagnostics.status === 'malformed'
          ? 'malformed'
          : 'empty_success',
    },
  };
}

function mapStreamedStreams(rows: unknown, fallbackSource?: string): PpvEmbed[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const stream = row as StreamedStream;
    const url = asString(stream.embedUrl);
    if (!isHostedEmbedUrl(url)) return [];
    return [
      {
        provider: 'streamed' as const,
        id: asString(stream.id) || undefined,
        source: asString(stream.source) || fallbackSource,
        language: asString(stream.language) || undefined,
        hd: typeof stream.hd === 'boolean' ? stream.hd : undefined,
        url,
      },
    ];
  });
}

/*
 * Each source is bounded and settled independently: one hung or failing source
 * must never discard the sources that did answer. Per-source outcomes are
 * recorded so a real-device run can tell "every request failed" apart from
 * "requests succeeded but were empty" and "embeds returned but policy refused
 * them".
 */
async function loadStreamedEmbeds(
  event: PpvEvent,
  request: FetchLike,
  diagnostics: PpvProviderDiagnostics,
): Promise<PpvEmbed[]> {
  const seenRefs = new Set<string>();
  const refs = event.sourceRefs.filter((ref) => {
    const key = `${ref.source}|${ref.id}`.toLowerCase();
    if (seenRefs.has(key)) return false;
    seenRefs.add(key);
    return true;
  });

  diagnostics.requestCount = refs.length;

  const results = await Promise.all(
    refs.map(async (ref) => {
      const outcome = await requestJson(
        `${STREAMED_API}/api/stream/${encodeURIComponent(ref.source)}/${encodeURIComponent(ref.id)}`,
        request,
      );
      if (outcome.status !== 'success') {
        recordFailure(diagnostics, outcome);
        return [] as PpvEmbed[];
      }

      diagnostics.completedRequests += 1;
      if (!Array.isArray(outcome.data)) {
        diagnostics.malformedResponseCount += 1;
        return [] as PpvEmbed[];
      }

      diagnostics.returnedSourceCount += outcome.data.length;
      const accepted: PpvEmbed[] = [];
      for (const row of outcome.data) {
        const url = asString((row as StreamedStream)?.embedUrl);
        if (!url) {
          diagnostics.malformedRowCount += 1;
          continue;
        }
        if (!isHostedEmbedUrl(url)) {
          recordRejection(diagnostics, url);
          continue;
        }
        accepted.push(...mapStreamedStreams([row], ref.source));
      }
      diagnostics.acceptedEmbedCount += accepted.length;
      return accepted;
    }),
  );

  return results.flat();
}

const SPORTSRC_CATEGORY = 'fight';

/*
 * Runs only when the event carries a SportSRC-native identifier. Sending the
 * Streamed ID here was an assumption, not a mapping: it 404'd for some events
 * and coincidentally resolved for others. With no native ID there is nothing
 * to ask about, so no request is made and the diagnostics say so rather than
 * inventing a provider failure.
 */
async function loadSportSrcEmbeds(
  event: PpvEvent,
  request: FetchLike,
  diagnostics: PpvProviderDiagnostics,
): Promise<PpvEmbed[]> {
  const ref = event.providerRefs?.sportsrc;
  const nativeEventId = asString(ref?.eventId);
  if (!nativeEventId) {
    diagnostics.providerNativeIdentityAvailable = false;
    diagnostics.lookupState = 'not_attempted_unmapped';
    diagnostics.requestCount = 0;
    return [];
  }

  /*
   * Defence in depth for a value that is dormant today: the category must look
   * like a plain provider label before it is used, and it is encoded on the way
   * into the URL regardless.
   */
  const category = sanitizeUpstreamCategory(ref?.category) || SPORTSRC_CATEGORY;
  diagnostics.providerNativeIdentityAvailable = true;
  diagnostics.lookupState = 'attempted';
  diagnostics.requestCount = 1;
  diagnostics.requestedCategory = category;
  diagnostics.responseSuccessFlag = null;
  diagnostics.hasData = false;
  diagnostics.hasSources = false;

  const outcome = await requestJson(
    `${SPORTSRC_API}/?data=detail&category=${encodeURIComponent(category)}&id=${encodeURIComponent(nativeEventId)}`,
    request,
  );
  if (outcome.status !== 'success') {
    recordFailure(diagnostics, outcome);
    return [];
  }

  diagnostics.completedRequests = 1;
  const payload = outcome.data as { success?: boolean; data?: { sources?: StreamedStream[] } } | null;
  const isObject = Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
  diagnostics.responseSuccessFlag = typeof payload?.success === 'boolean' ? payload.success : null;
  diagnostics.hasData = Boolean(payload?.data);

  const sources = payload?.data?.sources;
  if (!Array.isArray(sources)) {
    /*
     * success:false is a well-formed provider answer meaning "no result", so it
     * is recorded as an unsuccessful lookup. malformed is reserved for actual
     * structural contradictions - a body that is not an object at all, or one
     * claiming success while data/sources is missing or the wrong type.
     */
    if (isObject && payload?.success === false) {
      diagnostics.providerReportedUnsuccessful = true;
      return [];
    }
    diagnostics.malformedResponseCount += 1;
    return [];
  }

  diagnostics.hasSources = true;
  diagnostics.returnedSourceCount = sources.length;

  const accepted: PpvEmbed[] = [];
  for (const stream of sources) {
    const url = asString(stream?.embedUrl);
    if (!url) {
      diagnostics.malformedRowCount += 1;
      continue;
    }
    if (!isHostedEmbedUrl(url)) {
      recordRejection(diagnostics, url);
      continue;
    }
    accepted.push({
      provider: 'sportsrc' as const,
      id: asString(stream.id) || undefined,
      source: asString(stream.source) || undefined,
      language: asString(stream.language) || undefined,
      hd: typeof stream.hd === 'boolean' ? stream.hd : undefined,
      url,
    });
  }
  diagnostics.acceptedEmbedCount = accepted.length;
  return accepted;
}

/*
 * Streamed and SportSRC are the only embed discovery paths. They run together
 * and are individually bounded, so a slow Streamed lookup cannot stop SportSRC
 * from being attempted when the event carries a SportSRC-native identifier,
 * and an empty result costs one provider window rather than two. Every call settles into success, empty, timeout or failure.
 *
 * DaddyLive is not currently supported because no approved embed origin is
 * configured, so it is not requested at all.
 */
export interface PpvEmbedDiscovery {
  embeds: PpvEmbed[];
  diagnostics: PpvEventDiagnostics;
}

function finalStateFor(diagnostics: PpvEventDiagnostics): PpvEventDiagnostics['finalState'] {
  if (diagnostics.acceptedEmbedCount > 0) return 'playable_candidate';
  const providers = [diagnostics.streamed, diagnostics.sportsrc];
  if (providers.some((entry) => entry.rejectedEmbedCount > 0)) return 'policy_rejected';
  if (providers.some((entry) => entry.malformedResponseCount > 0 || entry.malformedRowCount > 0)) {
    return 'malformed';
  }
  /*
   * Only providers we actually asked can have failed. A backup skipped for want
   * of a native identity is not a provider failure - reporting it as one is how
   * "no sources exist for this event" got mistaken for "the backup is broken".
   */
  const attempted = providers.filter((entry) => entry.requestCount > 0);
  if (!attempted.length) return 'unavailable';
  if (attempted.some((entry) => entry.timeoutCount > 0)) return 'timeout';
  if (attempted.some((entry) => entry.httpErrorCount > 0 || entry.networkErrorCount > 0)) {
    return 'provider_failure';
  }
  return 'unavailable';
}

/*
 * Same request behaviour as loadPpvEmbeds, but returns the sanitized runtime
 * diagnostics alongside the embeds so a single real-device run can show where
 * an event actually failed.
 */
export async function discoverPpvEmbeds(
  event: PpvEvent,
  request: FetchLike = fetch,
): Promise<PpvEmbedDiscovery> {
  const diagnostics = emptyEventDiagnostics(event.providerEventId);

  const [streamed, sportsrc] = await Promise.all([
    loadStreamedEmbeds(event, request, diagnostics.streamed).catch(() => [] as PpvEmbed[]),
    loadSportSrcEmbeds(event, request, diagnostics.sportsrc).catch(() => [] as PpvEmbed[]),
  ]);

  const embeds = mergePpvEmbeds([...streamed, ...sportsrc]);
  diagnostics.acceptedEmbedCount = embeds.length;
  diagnostics.finalState = finalStateFor(diagnostics);
  return { embeds, diagnostics };
}

export async function loadPpvEmbeds(event: PpvEvent, request: FetchLike = fetch): Promise<PpvEmbed[]> {
  return (await discoverPpvEmbeds(event, request)).embeds;
}

export function formatPpvStart(startsAt: string): string {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return 'Time TBA';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatPpvCountdown(startsAt: string, now = Date.now()): string {
  const start = Date.parse(startsAt);
  if (!Number.isFinite(start)) return '';
  const delta = start - now;
  if (delta <= 0) return 'Live now';
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
