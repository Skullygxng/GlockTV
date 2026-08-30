/*
 * TheSportsDB catalog provider (v1 free tier).
 *
 * Primary event catalog. It is a documented sports-data API with a published
 * free key, queried only through its documented schedule endpoints - there is
 * no HTML scraping, no undocumented endpoint and no authentication to work
 * around. It supplies events only; it has nothing to do with playback, which
 * is exactly why it can stay useful when every stream provider is unreachable.
 *
 * Only combat sport is admitted. TheSportsDB classifies the sport itself
 * (strSport), and that classification is what admission runs on, through the
 * same shared gate every other catalog provider uses.
 *
 * Deliberately not read: strThumb / strPoster. Rendering a third-party image
 * URL discloses the viewer's IP and user agent to that host, and the existing
 * poster pass-through is already a known open item; this provider does not add
 * a second one.
 */

import {
  PPV_CATALOG_TIMEOUT_MS,
  classifyPpvCategory,
  derivePpvStatus,
  inferPromotion,
  isCombatPpvRow,
  requestJson,
  type PpvCategory,
  type PpvEvent,
  type PpvRequestOutcome,
} from './ppv';
import {
  emptyCatalogProviderDiagnostics,
  type PpvCatalogEndpointDiagnostics,
  type PpvRequestStatus,
} from './ppvDiagnostics';
import { youtubeVideoIdFrom } from './ppvAuthorizedEmbeds';
import { officialWatchUrlFor } from './ppvOfficialWatch';
import type { PpvCatalogProvider, PpvCatalogProviderResult, PpvFetchLike } from './ppvProviders';

export const THESPORTSDB_API = 'https://www.thesportsdb.com/api/v1/json';
/* The documented public test key for the free tier. Not a secret. */
export const THESPORTSDB_KEY = '123';
/* TheSportsDB's own name for the combat-sports bucket. */
export const THESPORTSDB_SPORT = 'Fighting';

/*
 * Today plus the next four days. The free tier allows 30 requests a minute and
 * the catalog refreshes every five minutes, so five day-queries per load stays
 * far inside the limit while still filling the Upcoming tab.
 */
export const THESPORTSDB_DAY_WINDOW = 5;

interface SportsDbEvent {
  idEvent?: unknown;
  idLeague?: unknown;
  strEvent?: unknown;
  strSport?: unknown;
  strLeague?: unknown;
  dateEvent?: unknown;
  strTime?: unknown;
  strTimestamp?: unknown;
  strHomeTeam?: unknown;
  strAwayTeam?: unknown;
  strVideo?: unknown;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function thesportsdbDayKey(offsetDays: number, now = Date.now()): string {
  const date = new Date(now + offsetDays * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/*
 * strTimestamp is documented as UTC without an offset marker, so one is added
 * rather than letting the runtime guess local time. dateEvent + strTime is the
 * documented fallback when the timestamp is absent.
 */
export function thesportsdbStartMs(row: SportsDbEvent): number | null {
  const stamp = asText(row.strTimestamp);
  if (stamp) {
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(stamp) ? stamp : `${stamp.replace(' ', 'T')}Z`;
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  const day = asText(row.dateEvent);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(asText(row.strTime))
    ? asText(row.strTime).padEnd(8, ':00').slice(0, 8)
    : '00:00:00';
  const parsed = Date.parse(`${day}T${time}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/*
 * League names carry the sub-category TheSportsDB does not break out. Only the
 * three categories the UI filters on are derived; anything else stays 'other'
 * rather than being guessed into a filter it may not belong in.
 */
export function thesportsdbCategory(eventName: string, league: string): PpvCategory {
  const direct = classifyPpvCategory(`${eventName} ${league}`);
  if (direct !== 'other') return direct;
  const haystack = league.toLowerCase();
  if (haystack.includes('wrestl')) return 'wrestling';
  /* Checked before the boxing test: "kickboxing" contains "box". */
  if (/mma|kickbox|muay thai|grappl|jiu ?jitsu/.test(haystack)) return 'mma';
  if (haystack.includes('box')) return 'boxing';
  return 'other';
}

export function mapSportsDbEvent(row: SportsDbEvent, now = Date.now()): PpvEvent | null {
  const nativeId = asText(row?.idEvent);
  const title = asText(row?.strEvent);
  if (!nativeId || !title) return null;

  const sport = asText(row?.strSport);
  const league = asText(row?.strLeague);
  /* TheSportsDB's own sport classification is the admission signal. */
  if (!isCombatPpvRow(title, sport)) return null;

  const startMs = thesportsdbStartMs(row);
  if (startMs == null) return null;

  const home = asText(row?.strHomeTeam);
  const away = asText(row?.strAwayTeam);
  const participants = home && away ? [home, away] : undefined;
  const promotion = inferPromotion(`${title} ${league}`);
  const videoId = youtubeVideoIdFrom(row?.strVideo);
  const leagueId = asText(row?.idLeague);

  return {
    provider: 'thesportsdb',
    providerEventId: `thesportsdb:${nativeId}`,
    providerRefs: {
      thesportsdb: { eventId: nativeId, ...(leagueId ? { leagueId } : {}) },
      ...(videoId ? { youtube: { videoId } } : {}),
    },
    catalogProvenance: { feeds: [], upstreamCategories: [sport.toLowerCase()].filter(Boolean) },
    title,
    category: thesportsdbCategory(title, league),
    promotion,
    participants,
    startsAt: new Date(startMs).toISOString(),
    status: derivePpvStatus(startMs, now),
    sourceRefs: [],
    embeds: [],
    playbackSources: [],
    officialWatchUrl: officialWatchUrlFor({ promotion }),
  };
}

function endpointFor(name: string, outcome: PpvRequestOutcome, rowCount: number): PpvCatalogEndpointDiagnostics {
  if (outcome.status !== 'success') {
    return {
      name,
      status: outcome.status,
      httpStatus: outcome.status === 'http_error' ? outcome.httpStatus : null,
      rowCount: 0,
    };
  }
  return { name, status: rowCount ? 'success' : 'empty_success', httpStatus: null, rowCount };
}

/*
 * Any single day answering is enough for the provider to count as reachable:
 * a quiet day with no fights is a real empty answer, not a provider failure,
 * and treating it as one is how "there are no events today" became "PPV is
 * broken".
 */
function overallStatusFor(endpoints: PpvCatalogEndpointDiagnostics[], admitted: number): PpvRequestStatus {
  if (admitted > 0) return 'success';
  const answered = endpoints.filter(
    (entry) => entry.status === 'success' || entry.status === 'empty_success',
  );
  if (answered.length) return 'empty_success';
  return endpoints[0]?.status ?? 'network_or_cors_error';
}

export async function loadTheSportsDbCatalog(
  request: PpvFetchLike = fetch,
  now = Date.now(),
): Promise<PpvCatalogProviderResult> {
  const diagnostics = emptyCatalogProviderDiagnostics('thesportsdb');
  const days = Array.from({ length: THESPORTSDB_DAY_WINDOW }, (_value, index) =>
    thesportsdbDayKey(index, now),
  );
  diagnostics.requestCount = days.length;

  const results = await Promise.all(
    days.map(async (day) => {
      const url = `${THESPORTSDB_API}/${encodeURIComponent(
        THESPORTSDB_KEY,
      )}/eventsday.php?d=${encodeURIComponent(day)}&s=${encodeURIComponent(THESPORTSDB_SPORT)}`;
      const outcome = await requestJson(url, request, PPV_CATALOG_TIMEOUT_MS);
      return { day, outcome };
    }),
  );

  const events = new Map<string, PpvEvent>();
  for (const { day, outcome } of results) {
    if (outcome.status !== 'success') {
      diagnostics.endpoints.push(endpointFor(day, outcome, 0));
      if (outcome.status === 'http_error' && !diagnostics.httpStatuses.includes(outcome.httpStatus)) {
        diagnostics.httpStatuses.push(outcome.httpStatus);
      }
      continue;
    }
    diagnostics.completedRequests += 1;

    const payload = outcome.data as { events?: unknown } | null;
    const isObject = Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload);
    /* A day with no fixtures is documented as events: null. */
    const rows = isObject && Array.isArray(payload?.events) ? (payload.events as SportsDbEvent[]) : [];
    if (!isObject || (payload?.events != null && !Array.isArray(payload.events))) {
      diagnostics.endpoints.push({ name: day, status: 'malformed', httpStatus: null, rowCount: 0 });
      diagnostics.malformedRowCount += 1;
      continue;
    }

    diagnostics.endpoints.push(endpointFor(day, outcome, rows.length));
    diagnostics.returnedRowCount += rows.length;
    for (const row of rows) {
      const mapped = mapSportsDbEvent(row, now);
      if (!mapped) {
        if (asText(row?.idEvent) && asText(row?.strEvent)) diagnostics.rejectedNonCombat += 1;
        else diagnostics.malformedRowCount += 1;
        continue;
      }
      if (!events.has(mapped.providerEventId)) events.set(mapped.providerEventId, mapped);
    }
  }

  const admitted = [...events.values()].filter((event) => event.status !== 'ended');
  diagnostics.admittedEvents = admitted.length;
  diagnostics.status = overallStatusFor(diagnostics.endpoints, admitted.length);
  return { events: admitted, diagnostics };
}

export const theSportsDbCatalogProvider: PpvCatalogProvider = {
  id: 'thesportsdb',
  label: 'TheSportsDB',
  load: (request, now) => loadTheSportsDbCatalog(request, now),
};
