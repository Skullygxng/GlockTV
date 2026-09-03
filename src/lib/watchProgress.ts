/*
 * What "where somebody got to" means, decided once.
 *
 * Pure - no React, no Supabase, no storage - so the rules that matter can be
 * tested directly: when a title counts as finished, when a position is worth
 * resuming from, and which of two disagreeing records wins.
 *
 * The rules live here rather than next to the player because there are two
 * places a record can come from (this device, and this account's other
 * devices) and they must not each decide for themselves.
 */

import type { MediaItem, MediaType } from './media';

/*
 * One place in one thing. season/episode are 0 for a movie rather than absent,
 * matching the primary key of watch_progress: a movie has one definite row.
 */
export interface ProgressEntry {
  mediaType: MediaType;
  mediaId: number;
  seasonNumber: number;
  episodeNumber: number;
  positionSeconds: number;
  /* Absent when the provider reported a position but never a length. */
  durationSeconds?: number;
  completed: boolean;
  /* Which playback server observed this, so resume can check it can accept it. */
  providerId?: string;
  /* Enough to draw a tile without asking TMDB. */
  title: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  updatedAt: string;
}

export type ProgressKey = string;

/*
 * Below this, resuming is worse than starting over: a viewer who watched the
 * studio logo and left does not want to be dropped 12 seconds in.
 */
export const MEANINGFUL_RESUME_SECONDS = 30;

/*
 * Finished, for the purpose of not cluttering Continue Watching.
 *
 * Two thresholds because one does not fit both shapes. 95% of a two-hour film
 * still leaves six minutes - long enough that somebody who stopped there
 * genuinely did not finish it. Ninety seconds from the end of a 22-minute
 * episode is the credits. Whichever comes first wins, so each length gets the
 * stricter answer.
 */
export const COMPLETION_FRACTION = 0.95;
export const COMPLETION_TAIL_SECONDS = 90;

/*
 * How far a local clock may run ahead before we stop believing it. A browser
 * clock is user-controlled and routinely wrong; the cloud's updated_at is the
 * database's own now(). This is the allowance for ordinary skew, not a
 * security boundary - the worst a wrong clock buys is a wrong resume point in
 * that person's own history.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function progressKey(
  item: Pick<MediaItem, 'id' | 'mediaType'>,
  seasonNumber = 0,
  episodeNumber = 0,
): ProgressKey {
  return item.mediaType === 'movie'
    ? `movie:${item.id}`
    : `tv:${item.id}:s${seasonNumber}:e${episodeNumber}`;
}

export function entryKey(entry: Pick<ProgressEntry, 'mediaType' | 'mediaId' | 'seasonNumber' | 'episodeNumber'>): ProgressKey {
  return progressKey(
    { id: entry.mediaId, mediaType: entry.mediaType },
    entry.seasonNumber,
    entry.episodeNumber,
  );
}

/* The identity half of a key, for records that arrive without one. */
export function parseProgressKey(key: string): Pick<ProgressEntry, 'mediaType' | 'mediaId' | 'seasonNumber' | 'episodeNumber'> | null {
  const movie = /^movie:(\d+)$/.exec(key);
  if (movie) {
    return { mediaType: 'movie', mediaId: Number(movie[1]), seasonNumber: 0, episodeNumber: 0 };
  }
  const tv = /^tv:(\d+):s(\d+):e(\d+)$/.exec(key);
  if (tv) {
    return {
      mediaType: 'tv',
      mediaId: Number(tv[1]),
      seasonNumber: Number(tv[2]),
      episodeNumber: Number(tv[3]),
    };
  }
  return null;
}

/*
 * The position past which a title counts as watched.
 *
 * Null when there is no duration: without a length there is no "near the end",
 * and inventing one would either bury something half-watched or keep something
 * finished forever.
 */
export function completionThreshold(durationSeconds: number | undefined): number | null {
  if (!isPositive(durationSeconds)) return null;
  const duration = durationSeconds!;
  const byFraction = duration * COMPLETION_FRACTION;
  /* On anything shorter than the tail, the fraction is the only sane rule. */
  if (duration <= COMPLETION_TAIL_SECONDS * 2) return byFraction;
  return Math.min(byFraction, duration - COMPLETION_TAIL_SECONDS);
}

export function isProgressComplete(positionSeconds: number, durationSeconds: number | undefined): boolean {
  const threshold = completionThreshold(durationSeconds);
  if (threshold === null) return false;
  return positionSeconds >= threshold;
}

/* Worth offering a resume for: real progress, and not already finished. */
export function isResumable(entry: ProgressEntry | null | undefined): boolean {
  if (!entry || entry.completed) return false;
  return entry.positionSeconds >= MEANINGFUL_RESUME_SECONDS;
}

/* 0-100, or null when there is no length to be a fraction of. */
export function progressPercent(entry: ProgressEntry): number | null {
  if (!isPositive(entry.durationSeconds)) return null;
  const ratio = entry.positionSeconds / entry.durationSeconds!;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function isPositive(value: number | undefined | null): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function wholeSeconds(value: unknown): number | null {
  /*
   * Number(null), Number('') and Number([]) are all 0, so coercing first would
   * turn a record with no position at all into a real one sitting at 0:00 -
   * a phantom entry that Continue Watching would then have to filter out by
   * luck. Only something that is already a number, or a string that reads as
   * one, is a position.
   */
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

function isoOrEpoch(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  /* An unreadable stamp must lose every comparison rather than win one. */
  return new Date(0).toISOString();
}

/*
 * Turn anything into a usable entry, or nothing.
 *
 * Both sources are untrusted in the ordinary sense: local storage is editable
 * by hand and a stale build may have written a different shape, and a cloud row
 * was written by some other device running some other version. A record that
 * cannot be read is dropped rather than repaired into a plausible-looking lie.
 */
export function sanitizeProgressEntry(raw: unknown): ProgressEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;

  const mediaType = value.mediaType === 'movie' || value.mediaType === 'tv'
    ? value.mediaType
    : null;
  const mediaId = wholeSeconds(value.mediaId);
  if (!mediaType || mediaId === null || mediaId <= 0) return null;

  const position = wholeSeconds(value.positionSeconds);
  if (position === null) return null;

  const duration = isPositive(Number(value.durationSeconds))
    ? Math.floor(Number(value.durationSeconds))
    : undefined;

  /*
   * A position past the end is a bad report, not a finished title: clamp it so
   * the progress bar cannot exceed 100% and a resume cannot seek past the end.
   */
  const clamped = duration ? Math.min(position, duration) : position;

  const season = wholeSeconds(value.seasonNumber) ?? 0;
  const episode = wholeSeconds(value.episodeNumber) ?? 0;

  return {
    mediaType,
    mediaId,
    seasonNumber: mediaType === 'movie' ? 0 : season,
    episodeNumber: mediaType === 'movie' ? 0 : episode,
    positionSeconds: clamped,
    durationSeconds: duration,
    /*
     * Recomputed, never simply believed. A stored true with a position near the
     * start is the signature of a bad write or a changed duration, and trusting
     * it would hide something the viewer is midway through.
     */
    completed: value.completed === true
      ? true
      : isProgressComplete(clamped, duration),
    providerId: typeof value.providerId === 'string' && value.providerId ? value.providerId : undefined,
    title: typeof value.title === 'string' ? value.title : '',
    posterPath: typeof value.posterPath === 'string' ? value.posterPath : null,
    backdropPath: typeof value.backdropPath === 'string' ? value.backdropPath : null,
    updatedAt: isoOrEpoch(value.updatedAt),
  };
}

/*
 * Which of two records for the same title is the truth.
 *
 * Newest wins, with one asymmetry that matters: `cloud.updatedAt` came from the
 * database's clock and `local.updatedAt` came from the browser's. So a local
 * stamp from the future is not newer, it is wrong, and a tie goes to the cloud.
 * That way a device whose clock is a day ahead cannot pin stale progress in
 * place across every other device.
 *
 * Duration is merged rather than taken wholesale: a provider that reported a
 * length once and not the next time should not erase the progress bar.
 */
export function reconcileProgress(
  local: ProgressEntry | null | undefined,
  cloud: ProgressEntry | null | undefined,
  now: number = Date.now(),
): ProgressEntry | null {
  const here = local ? sanitizeProgressEntry(local) : null;
  const there = cloud ? sanitizeProgressEntry(cloud) : null;
  if (!here) return there;
  if (!there) return here;

  const localAhead = Date.parse(here.updatedAt) > now + CLOCK_SKEW_TOLERANCE_MS;
  const winner = localAhead
    ? there
    : Date.parse(here.updatedAt) > Date.parse(there.updatedAt) ? here : there;
  const loser = winner === here ? there : here;

  if (winner.durationSeconds || !loser.durationSeconds) return winner;

  /* Carrying a length forward can newly satisfy the completion rule. */
  const durationSeconds = loser.durationSeconds;
  const positionSeconds = Math.min(winner.positionSeconds, durationSeconds);
  return {
    ...winner,
    durationSeconds,
    positionSeconds,
    completed: winner.completed || isProgressComplete(positionSeconds, durationSeconds),
  };
}

/*
 * Merge two whole sets, one key at a time. Used when a device that has been
 * recording locally meets the account's cloud history - at sign-in, and on
 * every refresh afterwards.
 */
export function reconcileProgressSets(
  local: ProgressEntry[],
  cloud: ProgressEntry[],
  now: number = Date.now(),
): ProgressEntry[] {
  const merged = new Map<ProgressKey, ProgressEntry>();

  for (const entry of local) {
    const clean = sanitizeProgressEntry(entry);
    if (clean) merged.set(entryKey(clean), clean);
  }

  for (const entry of cloud) {
    const clean = sanitizeProgressEntry(entry);
    if (!clean) continue;
    const key = entryKey(clean);
    const resolved = reconcileProgress(merged.get(key) ?? null, clean, now);
    if (resolved) merged.set(key, resolved);
  }

  return [...merged.values()];
}

/*
 * What Continue Watching shows: unfinished, real progress, newest first.
 *
 * Sorted here rather than by the database so a locally recorded entry and a
 * cloud one interleave correctly after reconciliation.
 */
export function continueWatchingEntries(entries: ProgressEntry[]): ProgressEntry[] {
  return entries
    .filter((entry) => isResumable(entry))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

/* A tile needs a MediaItem; a cloud row from another device has a snapshot.
   The gaps are left empty rather than guessed - the player fills them in from
   TMDB once it opens, and an invented year is worse than none. */
export function entryToMediaItem(entry: ProgressEntry, known?: MediaItem | null): MediaItem {
  if (known) return known;
  return {
    id: entry.mediaId,
    mediaType: entry.mediaType,
    title: entry.title || (entry.mediaType === 'movie' ? 'Untitled' : 'Untitled series'),
    overview: '',
    date: '',
    year: '',
    genreIds: [],
    genres: [],
    rating: 0,
    voteCount: 0,
    popularity: 0,
    runtime: null,
    posterPath: entry.posterPath ?? null,
    backdropPath: entry.backdropPath ?? null,
  };
}

export function formatProgressPosition(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(remainder)}`
    : `${minutes}:${pad(remainder)}`;
}
