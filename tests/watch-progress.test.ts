import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  COMPLETION_TAIL_SECONDS,
  MEANINGFUL_RESUME_SECONDS,
  completionThreshold,
  continueWatchingEntries,
  entryKey,
  entryToMediaItem,
  formatProgressPosition,
  isProgressComplete,
  isResumable,
  parseProgressKey,
  progressKey,
  progressPercent,
  reconcileProgress,
  reconcileProgressSets,
  sanitizeProgressEntry,
  type ProgressEntry,
} from '../src/lib/watchProgress';

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    mediaType: 'movie',
    mediaId: 550,
    seasonNumber: 0,
    episodeNumber: 0,
    positionSeconds: 600,
    durationSeconds: 7200,
    completed: false,
    providerId: 'cinesrc',
    title: 'Fight Club',
    posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('identity', () => {
  it('keys a movie without episode coordinates and a series with them', () => {
    expect(progressKey({ id: 550, mediaType: 'movie' })).toBe('movie:550');
    expect(progressKey({ id: 1399, mediaType: 'tv' }, 2, 7)).toBe('tv:1399:s2:e7');
  });

  it('round-trips a key back to the thing it names', () => {
    expect(parseProgressKey('tv:1399:s2:e7')).toEqual({
      mediaType: 'tv', mediaId: 1399, seasonNumber: 2, episodeNumber: 7,
    });
    expect(parseProgressKey('movie:550')).toEqual({
      mediaType: 'movie', mediaId: 550, seasonNumber: 0, episodeNumber: 0,
    });
  });

  it('refuses a key it does not recognise rather than guessing', () => {
    for (const bad of ['', 'movie:', 'movie:abc', 'tv:1399', 'tv:1399:s2', 'other:1', 'movie:550:s1:e1']) {
      expect(parseProgressKey(bad)).toBeNull();
    }
  });

  it('gives every episode of a series its own key', () => {
    const first = entryKey({ mediaType: 'tv', mediaId: 1399, seasonNumber: 1, episodeNumber: 1 });
    const second = entryKey({ mediaType: 'tv', mediaId: 1399, seasonNumber: 1, episodeNumber: 2 });
    expect(first).not.toBe(second);
  });
});

describe('when something counts as finished', () => {
  it('uses the credits rule for a feature and the fraction for an episode', () => {
    /* Two hours: 95% leaves six minutes, the tail leaves ninety seconds, and
       the earlier of the two is what a viewer would call finished. */
    expect(completionThreshold(7200)).toBe(6840);
    /* Twenty-two minutes: ninety seconds of credits is stricter than the 5%
       the fraction would leave, so the tail is what applies. */
    expect(completionThreshold(1320)).toBe(1230);
  });

  it('has no answer without a duration, rather than an invented one', () => {
    expect(completionThreshold(undefined)).toBeNull();
    expect(completionThreshold(0)).toBeNull();
    expect(isProgressComplete(99999, undefined)).toBe(false);
  });

  it('does not call something finished six minutes from the end of a short film', () => {
    /* A three-minute clip must not be "finished" at ninety seconds just
       because the tail rule would say so. */
    const threshold = completionThreshold(180)!;
    expect(threshold).toBeGreaterThan(180 - COMPLETION_TAIL_SECONDS);
    expect(isProgressComplete(95, 180)).toBe(false);
  });

  it('marks the end of a feature finished', () => {
    expect(isProgressComplete(6900, 7200)).toBe(true);
    expect(isProgressComplete(6000, 7200)).toBe(false);
  });
});

describe('what is worth resuming', () => {
  it('ignores the studio logo', () => {
    expect(isResumable(entry({ positionSeconds: MEANINGFUL_RESUME_SECONDS - 1 }))).toBe(false);
    expect(isResumable(entry({ positionSeconds: MEANINGFUL_RESUME_SECONDS }))).toBe(true);
  });

  it('does not offer to resume something already watched', () => {
    expect(isResumable(entry({ positionSeconds: 7000, completed: true }))).toBe(false);
  });

  it('treats nothing as nothing', () => {
    expect(isResumable(null)).toBe(false);
    expect(isResumable(undefined)).toBe(false);
  });
});

describe('sanitizing a record', () => {
  it('drops anything that is not identifiably a title', () => {
    expect(sanitizeProgressEntry(null)).toBeNull();
    expect(sanitizeProgressEntry('nope')).toBeNull();
    expect(sanitizeProgressEntry({ mediaType: 'podcast', mediaId: 1, positionSeconds: 5 })).toBeNull();
    expect(sanitizeProgressEntry({ mediaType: 'movie', mediaId: 0, positionSeconds: 5 })).toBeNull();
    expect(sanitizeProgressEntry({ mediaType: 'movie', mediaId: -3, positionSeconds: 5 })).toBeNull();
  });

  it('drops a position that is not a position', () => {
    for (const positionSeconds of [
      -1, Number.NaN, Number.POSITIVE_INFINITY, 'abc',
      /* Each of these coerces to 0, which would be a real position at the very
         start rather than the absence of one. */
      null, undefined, '', [], {},
    ]) {
      expect(sanitizeProgressEntry({ mediaType: 'movie', mediaId: 550, positionSeconds })).toBeNull();
    }
  });

  it('forgets a duration it cannot use instead of storing a bad one', () => {
    const clean = sanitizeProgressEntry({ ...entry(), durationSeconds: -10 });
    expect(clean?.durationSeconds).toBeUndefined();
    expect(progressPercent(clean!)).toBeNull();
  });

  it('clamps a position past the end rather than showing 140% watched', () => {
    const clean = sanitizeProgressEntry({ ...entry(), positionSeconds: 99999, durationSeconds: 7200 })!;
    expect(clean.positionSeconds).toBe(7200);
    expect(progressPercent(clean)).toBe(100);
  });

  it('recomputes completion instead of believing a stored flag', () => {
    /* A true near the start is the signature of a bad write or a changed
       duration. Believing it would hide something half-watched forever. */
    const early = sanitizeProgressEntry({ ...entry(), positionSeconds: 60, completed: true })!;
    expect(early.completed).toBe(true);
    const derived = sanitizeProgressEntry({ ...entry(), positionSeconds: 7000, completed: false })!;
    expect(derived.completed).toBe(true);
  });

  it('gives an unreadable timestamp one that loses every comparison', () => {
    const clean = sanitizeProgressEntry({ ...entry(), updatedAt: 'not a date' })!;
    expect(Date.parse(clean.updatedAt)).toBe(0);
  });

  it('normalises a movie so it cannot occupy two rows', () => {
    const clean = sanitizeProgressEntry({ ...entry(), seasonNumber: 4, episodeNumber: 9 })!;
    expect(clean.seasonNumber).toBe(0);
    expect(clean.episodeNumber).toBe(0);
  });
});

describe('reconciling two records', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');

  it('takes whichever side is genuinely newer', () => {
    const local = entry({ positionSeconds: 100, updatedAt: '2026-09-02T11:00:00.000Z' });
    const cloud = entry({ positionSeconds: 4000, updatedAt: '2026-09-02T11:30:00.000Z' });
    expect(reconcileProgress(local, cloud, now)?.positionSeconds).toBe(4000);
    expect(reconcileProgress(
      entry({ positionSeconds: 4000, updatedAt: '2026-09-02T11:30:00.000Z' }),
      entry({ positionSeconds: 100, updatedAt: '2026-09-02T11:00:00.000Z' }),
      now,
    )?.positionSeconds).toBe(4000);
  });

  it('carries a lone record through from either side', () => {
    expect(reconcileProgress(entry(), null, now)?.positionSeconds).toBe(600);
    expect(reconcileProgress(null, entry({ positionSeconds: 30 }), now)?.positionSeconds).toBe(30);
    expect(reconcileProgress(null, null, now)).toBeNull();
  });

  it('refuses to let a browser clock from the future pin stale progress', () => {
    /*
     * The asymmetry that matters. cloud.updatedAt is the database's clock;
     * local's is the device's, and a device a day ahead would otherwise win
     * every comparison forever and freeze this title across every other device.
     */
    const local = entry({
      positionSeconds: 100,
      updatedAt: new Date(now + CLOCK_SKEW_TOLERANCE_MS + 60_000).toISOString(),
    });
    const cloud = entry({ positionSeconds: 4000, updatedAt: '2026-09-02T11:00:00.000Z' });
    expect(reconcileProgress(local, cloud, now)?.positionSeconds).toBe(4000);
  });

  it('still accepts a local clock inside ordinary skew', () => {
    const local = entry({
      positionSeconds: 100,
      updatedAt: new Date(now + CLOCK_SKEW_TOLERANCE_MS - 60_000).toISOString(),
    });
    const cloud = entry({ positionSeconds: 4000, updatedAt: '2026-09-02T11:00:00.000Z' });
    expect(reconcileProgress(local, cloud, now)?.positionSeconds).toBe(100);
  });

  it('gives an exact tie to the database', () => {
    const stamp = '2026-09-02T11:00:00.000Z';
    const resolved = reconcileProgress(
      entry({ positionSeconds: 100, updatedAt: stamp }),
      entry({ positionSeconds: 4000, updatedAt: stamp }),
      now,
    );
    expect(resolved?.positionSeconds).toBe(4000);
  });

  it('keeps a known duration when the winning record lost one', () => {
    /* A provider that reported a length once and not the next time should not
       erase the progress bar. */
    const local = entry({ positionSeconds: 900, durationSeconds: undefined, updatedAt: '2026-09-02T11:30:00.000Z' });
    const cloud = entry({ positionSeconds: 600, durationSeconds: 7200, updatedAt: '2026-09-02T11:00:00.000Z' });
    const resolved = reconcileProgress(local, cloud, now)!;
    expect(resolved.positionSeconds).toBe(900);
    expect(resolved.durationSeconds).toBe(7200);
  });

  it('can newly finish a title once a duration is carried forward', () => {
    const local = entry({ positionSeconds: 7100, durationSeconds: undefined, updatedAt: '2026-09-02T11:30:00.000Z' });
    const cloud = entry({ positionSeconds: 600, durationSeconds: 7200, updatedAt: '2026-09-02T11:00:00.000Z' });
    expect(reconcileProgress(local, cloud, now)?.completed).toBe(true);
  });

  it('clamps when a carried duration is shorter than the winning position', () => {
    /* A re-cut release can be shorter than the one a position was taken from. */
    const local = entry({ positionSeconds: 9000, durationSeconds: undefined, updatedAt: '2026-09-02T11:30:00.000Z' });
    const cloud = entry({ positionSeconds: 100, durationSeconds: 3600, updatedAt: '2026-09-02T11:00:00.000Z' });
    const resolved = reconcileProgress(local, cloud, now)!;
    expect(resolved.positionSeconds).toBe(3600);
    expect(progressPercent(resolved)).toBe(100);
  });

  it('discards a malformed side instead of failing the merge', () => {
    expect(reconcileProgress({ nonsense: true } as never, entry(), now)?.positionSeconds).toBe(600);
    expect(reconcileProgress(entry(), { nonsense: true } as never, now)?.positionSeconds).toBe(600);
  });
});

describe('merging whole sets', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');

  it('keeps entries unique to either side and resolves the overlap', () => {
    const local = [
      entry({ mediaId: 1, positionSeconds: 100, updatedAt: '2026-09-02T11:30:00.000Z' }),
      entry({ mediaId: 2, positionSeconds: 200, updatedAt: '2026-09-02T10:00:00.000Z' }),
    ];
    const cloud = [
      entry({ mediaId: 2, positionSeconds: 3000, updatedAt: '2026-09-02T11:00:00.000Z' }),
      entry({ mediaId: 3, positionSeconds: 300, updatedAt: '2026-09-02T09:00:00.000Z' }),
    ];
    const merged = reconcileProgressSets(local, cloud, now);
    const byId = new Map(merged.map((item) => [item.mediaId, item.positionSeconds]));
    expect(byId.get(1)).toBe(100);
    expect(byId.get(2)).toBe(3000);
    expect(byId.get(3)).toBe(300);
    expect(merged).toHaveLength(3);
  });

  it('does not merge two episodes of one series into one row', () => {
    const merged = reconcileProgressSets(
      [entry({ mediaType: 'tv', mediaId: 1399, seasonNumber: 1, episodeNumber: 1, positionSeconds: 100 })],
      [entry({ mediaType: 'tv', mediaId: 1399, seasonNumber: 1, episodeNumber: 2, positionSeconds: 200 })],
      now,
    );
    expect(merged).toHaveLength(2);
  });

  it('drops unreadable records from either side', () => {
    const merged = reconcileProgressSets(
      [entry(), { junk: 1 } as never],
      [{ junk: 2 } as never],
      now,
    );
    expect(merged).toHaveLength(1);
  });
});

describe('what Continue Watching shows', () => {
  it('is unfinished titles with real progress, newest first', () => {
    const shown = continueWatchingEntries([
      entry({ mediaId: 1, positionSeconds: 600, updatedAt: '2026-09-01T10:00:00.000Z' }),
      entry({ mediaId: 2, positionSeconds: 7100, completed: true, updatedAt: '2026-09-02T10:00:00.000Z' }),
      entry({ mediaId: 3, positionSeconds: 5, updatedAt: '2026-09-03T10:00:00.000Z' }),
      entry({ mediaId: 4, positionSeconds: 900, updatedAt: '2026-09-02T18:00:00.000Z' }),
    ]);
    /* 2 is finished and 3 is the studio logo. */
    expect(shown.map((item) => item.mediaId)).toEqual([4, 1]);
  });
});

describe('presentation', () => {
  it('reads a percentage only when there is a length to be a fraction of', () => {
    expect(progressPercent(entry({ positionSeconds: 3600, durationSeconds: 7200 }))).toBe(50);
    expect(progressPercent(entry({ durationSeconds: undefined }))).toBeNull();
  });

  it('writes a timestamp the way a player does', () => {
    expect(formatProgressPosition(0)).toBe('0:00');
    expect(formatProgressPosition(65)).toBe('1:05');
    expect(formatProgressPosition(3661)).toBe('1:01:01');
    expect(formatProgressPosition(-5)).toBe('0:00');
  });

  it('builds a card from the snapshot without inventing a year or a rating', () => {
    const item = entryToMediaItem(entry({ title: 'Fight Club' }));
    expect(item.title).toBe('Fight Club');
    expect(item.year).toBe('');
    expect(item.rating).toBe(0);
    expect(item.genres).toEqual([]);
  });

  it('prefers a title this session already knows', () => {
    const known = { ...entryToMediaItem(entry()), overview: 'A real overview', year: '1999' };
    expect(entryToMediaItem(entry(), known).overview).toBe('A real overview');
  });
});
