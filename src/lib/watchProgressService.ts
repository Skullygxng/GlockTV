import type { SupabaseClient } from '@supabase/supabase-js';
import { entryKey, sanitizeProgressEntry, type ProgressEntry } from './watchProgress';
import { getSupabaseClient, type SupabaseConfig } from './supabaseClient';

/*
 * The cloud half of playback progress.
 *
 * Every call here runs as the signed-in viewer under RLS, using the same
 * publishable key the rest of the app holds. That is deliberate and safe in a
 * way the billing tables are not: a row here says where somebody got to in a
 * film, so the worst a compromised session can write is a wrong resume point
 * in its own owner's history. There is no service-role path and no privileged
 * function, because progress needs no authority to be correct.
 *
 * Note what is absent: nothing here signs anybody in. GlockTV is guest-first,
 * and pressing play must never mint an account as a side effect - a visitor
 * with no session keeps their progress on the device and nowhere else. The
 * account layer follows the same rule.
 */
export interface WatchProgressService {
  /* Always resolves. A failure returns no entries and a message, never throws,
     because a player must not fail to open because history was unavailable. */
  list(): Promise<{ entries: ProgressEntry[]; error: string }>;
  /* Resolves false when there was nobody to save for, or the write failed. */
  save(entry: ProgressEntry): Promise<boolean>;
  remove(identity: Pick<ProgressEntry, 'mediaType' | 'mediaId' | 'seasonNumber' | 'episodeNumber'>): Promise<boolean>;
}

const TABLE = 'watch_progress';

/* How many titles Continue Watching will ever show. Far more than anybody
   scrolls, and small enough that the query stays a single indexed read. */
export const PROGRESS_PAGE_SIZE = 60;

interface ProgressRow {
  media_type?: unknown;
  media_id?: unknown;
  season_number?: unknown;
  episode_number?: unknown;
  position_seconds?: unknown;
  duration_seconds?: unknown;
  completed?: unknown;
  provider_id?: unknown;
  title?: unknown;
  poster_path?: unknown;
  backdrop_path?: unknown;
  updated_at?: unknown;
}

/*
 * A row was written by some other device running some other version of this
 * code, so it is read through the same sanitizer as local storage rather than
 * being trusted for having come from a database.
 */
export function rowToEntry(row: ProgressRow | null | undefined): ProgressEntry | null {
  if (!row) return null;
  return sanitizeProgressEntry({
    mediaType: row.media_type,
    mediaId: row.media_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    positionSeconds: row.position_seconds,
    durationSeconds: row.duration_seconds,
    completed: row.completed,
    providerId: row.provider_id,
    title: row.title,
    posterPath: row.poster_path,
    backdropPath: row.backdrop_path,
    updatedAt: row.updated_at,
  });
}

export function entryToRow(entry: ProgressEntry, userId: string) {
  return {
    user_id: userId,
    media_type: entry.mediaType,
    media_id: entry.mediaId,
    season_number: entry.seasonNumber,
    episode_number: entry.episodeNumber,
    position_seconds: entry.positionSeconds,
    duration_seconds: entry.durationSeconds ?? null,
    completed: entry.completed,
    provider_id: entry.providerId ?? null,
    title: entry.title,
    poster_path: entry.posterPath ?? null,
    backdrop_path: entry.backdropPath ?? null,
    /*
     * The client's stamp, not the column default, because reconciliation
     * compares this against a local stamp and both sides have to describe the
     * same moment. A wrong browser clock is handled where the comparison
     * happens - reconcileProgress refuses to let a future stamp win - rather
     * than by pretending the write time is the observation time.
     */
    updated_at: entry.updatedAt,
  };
}

export function createWatchProgressService(client: SupabaseClient): WatchProgressService {
  /* The caller's own id, or null. Never creates one. */
  async function currentUserId(): Promise<string | null> {
    const { data } = await client.auth.getSession();
    return data.session?.user?.id ?? null;
  }

  return {
    async list() {
      try {
        if (!(await currentUserId())) return { entries: [], error: '' };

        /*
         * No user_id filter: RLS returns only the caller's rows, so asking for
         * "the rows" is asking for theirs. Filtering by a client-held id would
         * imply the id is what protects them.
         */
        const { data, error } = await client
          .from(TABLE)
          .select('media_type, media_id, season_number, episode_number, position_seconds, duration_seconds, completed, provider_id, title, poster_path, backdrop_path, updated_at')
          .order('updated_at', { ascending: false })
          .limit(PROGRESS_PAGE_SIZE);

        if (error) return { entries: [], error: error.message };

        const entries = (data ?? [])
          .map((row) => rowToEntry(row as ProgressRow))
          .filter((entry): entry is ProgressEntry => entry !== null);
        return { entries, error: '' };
      } catch (reason) {
        return {
          entries: [],
          error: reason instanceof Error ? reason.message : 'Your watch history is unavailable.',
        };
      }
    },

    async save(entry) {
      try {
        const userId = await currentUserId();
        if (!userId) return false;

        /*
         * Upsert on the natural key, so the same title updates in place rather
         * than accumulating a row per session. The conflict target names the
         * primary key columns explicitly - relying on the default would let a
         * later index change silently turn updates into duplicates.
         */
        const { error } = await client
          .from(TABLE)
          .upsert(entryToRow(entry, userId), {
            onConflict: 'user_id,media_type,media_id,season_number,episode_number',
          });
        return !error;
      } catch {
        /* Losing a progress write is a lost resume point, not a broken player. */
        return false;
      }
    },

    async remove(identity) {
      try {
        if (!(await currentUserId())) return false;
        const { error } = await client
          .from(TABLE)
          .delete()
          .eq('media_type', identity.mediaType)
          .eq('media_id', identity.mediaId)
          .eq('season_number', identity.seasonNumber)
          .eq('episode_number', identity.episodeNumber);
        return !error;
      } catch {
        return false;
      }
    },
  };
}

/* Null when Supabase is not configured; progress then lives on the device
   only, which is exactly a guest's experience. */
export function createDefaultWatchProgressService(config: SupabaseConfig = {}): WatchProgressService | null {
  const client = getSupabaseClient(config);
  return client ? createWatchProgressService(client) : null;
}

/* Re-exported so callers that only touch the service do not have to reach into
   the domain module for the one function that makes two records into one. */
export { entryKey };
