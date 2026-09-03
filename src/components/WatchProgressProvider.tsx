import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  continueWatchingEntries,
  entryKey,
  isProgressComplete,
  reconcileProgressSets,
  type ProgressEntry,
  type ProgressKey,
} from '../lib/watchProgress';
import {
  localProgressEntries,
  removeLocalProgress,
  savePlaybackProgress,
  writeLocalProgressEntry,
  type ProgressSubject,
} from '../lib/playbackProgress';
import {
  createDefaultWatchProgressService,
  type WatchProgressService,
} from '../lib/watchProgressService';
import { useAccount } from './AccountProvider';

/*
 * The one owner of personal playback progress.
 *
 * Two layers meet here and nowhere else: this device's local store, which every
 * visitor gets including guests, and the account's cloud rows, which a
 * protected account gets across devices. Features ask this rather than either
 * layer directly, so there is a single answer to "where did I get to" on screen
 * at any moment and a single place that decides which record wins.
 *
 * It is emphatically not watch-party state. A room's position belongs to the
 * room and is shared; these entries belong to one viewer and follow them.
 * Nothing in Friends reads or writes through here.
 */

/*
 * How often progress may reach the network while something is playing.
 *
 * A player emits timeupdate several times a second. Local storage can absorb
 * that; Supabase should not be asked to. Ten seconds means at most six writes
 * a minute per title, and the trailing flush below means the last position is
 * never the one that got throttled away.
 */
export const CLOUD_SYNC_INTERVAL_MS = 10_000;

export interface WatchProgressState {
  /* Everything known about this viewer, reconciled. */
  entries: ProgressEntry[];
  /* Unfinished, real progress, newest first - what Continue Watching shows. */
  continueWatching: ProgressEntry[];
  ready: boolean;
  /* Non-blocking: a failure here still leaves a working player. */
  error: string;
  entryFor: (
    item: { id: number; mediaType: ProgressEntry['mediaType'] },
    seasonNumber?: number,
    episodeNumber?: number,
  ) => ProgressEntry | null;
  /* Record an observed position. Local write is immediate; the cloud write is
     throttled unless flush is asked for. */
  recordProgress: (input: RecordProgressInput) => void;
  /* Send anything still pending now - pause, close, episode change. */
  flushProgress: () => Promise<void>;
  /* Forget a title, here and in the cloud. */
  forgetProgress: (
    identity: Pick<ProgressEntry, 'mediaType' | 'mediaId' | 'seasonNumber' | 'episodeNumber'>,
  ) => Promise<void>;
  refresh: () => Promise<void>;
}

export interface RecordProgressInput {
  subject: ProgressSubject;
  positionSeconds: number;
  durationSeconds?: number;
  providerId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /* True for pause, ended and close: the position that matters most. */
  flush?: boolean;
}

const WatchProgressContext = createContext<WatchProgressState | null>(null);

let defaultService: WatchProgressService | null | undefined;
function getDefaultService(): WatchProgressService | null {
  if (defaultService === undefined) defaultService = createDefaultWatchProgressService();
  return defaultService;
}

export function WatchProgressProvider({
  service: providedService,
  children,
}: {
  /* Omit to use the app's own service; pass null to run device-local only. */
  service?: WatchProgressService | null;
  children: ReactNode;
}) {
  const service = providedService === undefined ? getDefaultService() : providedService;
  const { account, ready: accountReady } = useAccount();

  /*
   * Whether this visitor's progress belongs in the cloud at all.
   *
   * Guests - including a guest holding an anonymous Supabase session, which is
   * how the watch party mints an identity - keep the device-local layer and
   * nothing more. An anonymous identity lives in this browser's storage, so
   * "across your devices" is a promise nothing could keep for it.
   *
   * This is a request-avoidance check, not the boundary. The RLS policies
   * refuse an anonymous writer, so a modified client that ignores this gets the
   * same answer from the database.
   *
   * It flips to true the moment a guest protects their account, and because
   * Supabase keeps the same uid when an email is attached, that costs nothing:
   * the local rows this device already holds sync up under the identity they
   * were always keyed to. Nothing is migrated and nothing is deleted.
   */
  const cloudEligible = Boolean(service) && accountReady && account !== null && !account.isAnonymous;

  const [entries, setEntries] = useState<ProgressEntry[]>(() => localProgressEntries());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  /* Entries observed but not yet sent, keyed so a later position for the same
     title replaces an earlier one rather than queueing behind it. */
  const pending = useRef(new Map<ProgressKey, ProgressEntry>());
  const timer = useRef<number | null>(null);
  /* A slow sync must not overwrite a newer one. */
  const version = useRef(0);

  const sendPending = useCallback(async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!service || pending.current.size === 0) return;

    const batch = [...pending.current.values()];
    pending.current.clear();
    /* Sequential rather than parallel: this is a handful of rows for one
       person, and a burst of concurrent upserts on one primary key is how you
       get avoidable write conflicts. */
    for (const entry of batch) {
      await service.save(entry);
    }
  }, [service]);

  const scheduleSend = useCallback(() => {
    if (!service || timer.current !== null) return;
    timer.current = window.setTimeout(() => { void sendPending(); }, CLOUD_SYNC_INTERVAL_MS);
  }, [service, sendPending]);

  /*
   * Bring the two layers together.
   *
   * Reconciliation is symmetric: whichever record is genuinely newer wins, and
   * the result is written back down to this device so the local store stops
   * being behind. Entries this device had that the cloud does not - the
   * offline case, and the guest who has just protected their account - are
   * pushed up, which is why signing in does not lose a session's worth of
   * watching.
   */
  const sync = useCallback(async () => {
    const request = ++version.current;
    const local = localProgressEntries();

    /*
     * Local-only: the unconfigured build, and every guest.
     *
     * The outbox is dropped rather than left to accumulate writes that would be
     * refused - but only once the account layer has actually answered. Before
     * that this is "we do not know yet", and discarding a position recorded in
     * that window would lose a real write for an ordinary signed-in viewer who
     * pressed play during start-up.
     */
    if (!service || !cloudEligible) {
      if (!service || accountReady) pending.current.clear();
      if (request === version.current) {
        setEntries(local);
        setError('');
        setReady(true);
      }
      return;
    }

    const { entries: cloud, error: listError } = await service.list();
    if (request !== version.current) return;

    const merged = reconcileProgressSets(local, cloud);
    const cloudByKey = new Map(cloud.map((entry) => [entryKey(entry), entry]));

    for (const entry of merged) {
      const key = entryKey(entry);
      const remote = cloudByKey.get(key);
      /* Newer here than there - or not there at all - so the cloud is behind. */
      if (!remote || Date.parse(entry.updatedAt) > Date.parse(remote.updatedAt)) {
        pending.current.set(key, entry);
      }
      writeLocalProgressEntry(entry);
    }

    setEntries(merged);
    setError(listError);
    setReady(true);
    await sendPending();
  }, [service, cloudEligible, accountReady, sendPending]);

  /*
   * Re-syncs whenever eligibility or identity changes. Protecting a guest
   * account flips cloudEligible, which is what carries a session's worth of
   * local watching up to an account that has only just started existing in the
   * cloud sense - under the same uid it already had.
   */
  useEffect(() => {
    void sync();
  }, [sync, account?.id]);

  const recordProgress = useCallback((input: RecordProgressInput) => {
    const seasonNumber = input.subject.mediaType === 'movie' ? 0 : input.seasonNumber ?? 1;
    const episodeNumber = input.subject.mediaType === 'movie' ? 0 : input.episodeNumber ?? 1;

    const saved = savePlaybackProgress(
      input.subject,
      {
        position: input.positionSeconds,
        duration: input.durationSeconds,
        serverId: input.providerId,
        completed: isProgressComplete(input.positionSeconds, input.durationSeconds),
      },
      seasonNumber,
      episodeNumber,
    );
    if (!saved) return;

    const entry: ProgressEntry = {
      mediaType: input.subject.mediaType,
      mediaId: input.subject.id,
      seasonNumber,
      episodeNumber,
      positionSeconds: saved.position,
      durationSeconds: saved.duration,
      completed: saved.completed === true,
      providerId: saved.serverId,
      title: saved.title ?? input.subject.title ?? '',
      posterPath: saved.posterPath ?? null,
      backdropPath: saved.backdropPath ?? null,
      updatedAt: saved.updatedAt,
    };

    const key = entryKey(entry);
    setEntries((current) => {
      const next = current.filter((candidate) => entryKey(candidate) !== key);
      next.push(entry);
      return next;
    });

    /* Recorded locally above regardless. Only the cloud half is gated. */
    if (!service || !cloudEligible) return;
    pending.current.set(key, entry);
    if (input.flush) {
      void sendPending();
      return;
    }
    scheduleSend();
  }, [service, cloudEligible, sendPending, scheduleSend]);

  const forgetProgress = useCallback(async (
    identity: Pick<ProgressEntry, 'mediaType' | 'mediaId' | 'seasonNumber' | 'episodeNumber'>,
  ) => {
    const key = entryKey(identity);
    /* Drop it from the outbox first, or a queued write would resurrect it. */
    pending.current.delete(key);
    removeLocalProgress(
      { id: identity.mediaId, mediaType: identity.mediaType },
      identity.seasonNumber,
      identity.episodeNumber,
    );
    setEntries((current) => current.filter((candidate) => entryKey(candidate) !== key));
    /* The local delete above already happened, so a guest forgetting a title
       still forgets it. There is simply no cloud row to remove as well. */
    if (cloudEligible) await service?.remove(identity);
  }, [service, cloudEligible]);

  /*
   * A closing tab is the most likely moment for the newest position to be the
   * one still waiting. pagehide fires on mobile Safari where unload does not,
   * and hidden covers the app being backgrounded without being closed.
   */
  useEffect(() => {
    const flush = () => { void sendPending(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [sendPending]);

  const value = useMemo<WatchProgressState>(() => {
    const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
    return {
      entries,
      continueWatching: continueWatchingEntries(entries),
      ready,
      error,
      entryFor: (item, seasonNumber = 1, episodeNumber = 1) => byKey.get(entryKey({
        mediaType: item.mediaType,
        mediaId: item.id,
        seasonNumber: item.mediaType === 'movie' ? 0 : seasonNumber,
        episodeNumber: item.mediaType === 'movie' ? 0 : episodeNumber,
      })) ?? null,
      recordProgress,
      flushProgress: sendPending,
      forgetProgress,
      refresh: sync,
    };
  }, [entries, ready, error, recordProgress, sendPending, forgetProgress, sync]);

  return <WatchProgressContext.Provider value={value}>{children}</WatchProgressContext.Provider>;
}

/*
 * Outside a provider this reports an empty, device-local view rather than
 * throwing. A component rendered without the provider is a wiring mistake, but
 * "no history" is a safe reading of it and a better failure than a blank
 * screen mid-film.
 */
export function useWatchProgress(): WatchProgressState {
  const value = useContext(WatchProgressContext);
  if (value) return value;
  return {
    entries: [],
    continueWatching: [],
    ready: true,
    error: '',
    entryFor: () => null,
    recordProgress: () => {},
    flushProgress: async () => {},
    forgetProgress: async () => {},
    refresh: async () => {},
  };
}
