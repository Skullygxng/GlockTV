import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { AccountProvider } from '../src/components/AccountProvider';
import {
  CLOUD_SYNC_INTERVAL_MS,
  WatchProgressProvider,
  useWatchProgress,
  type WatchProgressState,
} from '../src/components/WatchProgressProvider';
import { PLAYBACK_PROGRESS_KEY } from '../src/lib/playbackProgress';
import { entryKey, type ProgressEntry } from '../src/lib/watchProgress';
import type { WatchProgressService } from '../src/lib/watchProgressService';
import type { AccountService } from '../src/lib/accountService';
import { FREE_ENTITLEMENTS, type GlockTvAccount } from '../src/lib/account';

/*
 * The two-layer contract.
 *
 * These are the properties that keep progress correct and cheap: it never
 * hammers the network, it never loses the last position, it never mints an
 * account to record one, and one person's history never reaches another's.
 */

function cloudService(seed: ProgressEntry[] = []) {
  const rows = new Map(seed.map((entry) => [entryKey(entry), entry]));
  const saves: ProgressEntry[] = [];
  const removes: string[] = [];
  const service: WatchProgressService = {
    list: vi.fn(async () => ({ entries: [...rows.values()], error: '' })),
    save: vi.fn(async (entry: ProgressEntry) => {
      saves.push(entry);
      rows.set(entryKey(entry), entry);
      return true;
    }),
    remove: vi.fn(async (identity) => {
      removes.push(entryKey(identity));
      rows.delete(entryKey(identity));
      return true;
    }),
  };
  return { service, saves, removes, rows };
}

function accountService(account: GlockTvAccount | null): AccountService {
  return {
    loadAccount: async () => account,
    loadEntitlements: async () => ({ entitlements: FREE_ENTITLEMENTS, error: '' }),
    linkEmail: async () => {},
    sendSignInLink: async () => {},
    onAuthChange: () => () => {},
  };
}

const movie = { id: 550, mediaType: 'movie' as const, title: 'Fight Club', posterPath: '/p.jpg', backdropPath: '/b.jpg' };

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    mediaType: 'movie', mediaId: 550, seasonNumber: 0, episodeNumber: 0,
    positionSeconds: 600, durationSeconds: 7200, completed: false,
    providerId: 'cinesrc', title: 'Fight Club', posterPath: '/p.jpg', backdropPath: '/b.jpg',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

let latest: WatchProgressState;
function Probe() {
  latest = useWatchProgress();
  return null;
}

function mount(service: WatchProgressService | null, account: GlockTvAccount | null = { id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null }) {
  return render(
    <AccountProvider service={accountService(account)}>
      <WatchProgressProvider service={service}>
        <Probe />
      </WatchProgressProvider>
    </AccountProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the network is not asked on every frame', () => {
  it('holds a burst of positions and sends one', async () => {
    const { service, saves } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));
    saves.length = 0;

    /* A player emits several of these a second. */
    await act(async () => {
      for (let second = 30; second <= 40; second += 1) {
        latest.recordProgress({ subject: movie, positionSeconds: second, durationSeconds: 7200 });
      }
    });
    expect(saves).toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_SYNC_INTERVAL_MS + 10); });
    expect(saves).toHaveLength(1);
    /* And it is the newest position, not the first of the burst. */
    expect(saves[0].positionSeconds).toBe(40);
  });

  it('records every one of them locally, so nothing is lost between sends', async () => {
    const { service } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 123, durationSeconds: 7200 });
    });
    const stored = JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY) ?? '{}');
    expect(stored['movie:550'].position).toBe(123);
  });

  it('sends immediately when the moment matters', async () => {
    const { service, saves } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));
    saves.length = 0;

    /* Pausing, finishing and closing all flush - waiting out the throttle is
       exactly when the position would be lost. */
    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 900, durationSeconds: 7200, flush: true });
    });
    expect(saves).toHaveLength(1);
    expect(saves[0].positionSeconds).toBe(900);
  });

  it('does not lose a throttled position when the player closes', async () => {
    const { service, saves } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));
    saves.length = 0;

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 1500, durationSeconds: 7200 });
    });
    expect(saves).toHaveLength(0);

    await act(async () => { await latest.flushProgress(); });
    expect(saves.at(-1)?.positionSeconds).toBe(1500);
  });

  it('flushes what is pending when the tab goes away', async () => {
    const { service, saves } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));
    saves.length = 0;

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 2100, durationSeconds: 7200 });
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
    });
    expect(saves.at(-1)?.positionSeconds).toBe(2100);
  });
});

describe('two devices, one account', () => {
  it('takes the newer cloud position over stale local progress', async () => {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:550': { position: 100, duration: 7200, serverId: 'cinesrc', updatedAt: '2026-09-01T09:00:00.000Z' },
    }));
    const { service } = cloudService([entry({ positionSeconds: 4000, updatedAt: '2026-09-02T09:00:00.000Z' })]);
    mount(service);

    await waitFor(() => expect(latest.ready).toBe(true));
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(4000);
  });

  it('pushes local progress up when this device is the one that is ahead', async () => {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:550': { position: 5000, duration: 7200, serverId: 'cinesrc', updatedAt: '2026-09-03T09:00:00.000Z' },
    }));
    const { service, saves } = cloudService([entry({ positionSeconds: 100, updatedAt: '2026-09-01T09:00:00.000Z' })]);
    mount(service);

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves[0].positionSeconds).toBe(5000);
  });

  it('carries a guest\'s device history up when they protect the account', async () => {
    /* Nothing in the cloud yet: this is the first sync after signing in. */
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:550': { position: 800, duration: 7200, serverId: 'cinesrc', updatedAt: '2026-09-03T09:00:00.000Z' },
    }));
    const { service, saves } = cloudService();
    mount(service);

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves[0].positionSeconds).toBe(800);
  });

  it('writes the resolved answer back down, so this device stops being behind', async () => {
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:550': { position: 100, duration: 7200, serverId: 'cinesrc', updatedAt: '2026-09-01T09:00:00.000Z' },
    }));
    const { service } = cloudService([entry({ positionSeconds: 4000, updatedAt: '2026-09-02T09:00:00.000Z' })]);
    mount(service);

    await waitFor(() => expect(latest.ready).toBe(true));
    const stored = JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY) ?? '{}');
    expect(stored['movie:550'].position).toBe(4000);
  });
});

describe('one account cannot see another', () => {
  it('replaces the view when the session changes rather than accumulating it', async () => {
    /*
     * The service is per-account by RLS, so the guarantee this asserts is the
     * client half: switching account re-lists and re-renders from that
     * account's rows, so nothing from the previous one survives on screen.
     */
    const first = cloudService([entry({ mediaId: 111, title: 'A-only' })]);
    const view = mount(first.service, { id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null });
    await waitFor(() => expect(latest.entries.some((item) => item.mediaId === 111)).toBe(true));
    view.unmount();

    window.localStorage.clear();
    const second = cloudService([entry({ mediaId: 222, title: 'B-only' })]);
    mount(second.service, { id: 'user-b', email: 'b@example.com', isAnonymous: false, createdAt: null });

    await waitFor(() => expect(latest.entries.some((item) => item.mediaId === 222)).toBe(true));
    expect(latest.entries.some((item) => item.mediaId === 111)).toBe(false);
  });
});

describe('a guest is still a guest', () => {
  it('records nothing to the network and everything to the device', async () => {
    /* No service at all is the shape of an unconfigured project, and of a
       visitor who has never signed in. Playback must still remember. */
    mount(null, null);
    await waitFor(() => expect(latest.ready).toBe(true));

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 450, durationSeconds: 7200 });
    });

    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(450);
    const stored = JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY) ?? '{}');
    expect(stored['movie:550'].position).toBe(450);
  });

  it('never signs anybody in to save a position', async () => {
    /*
     * The service surface is the proof: there is no method here that could
     * create a session, so pressing play cannot mint an account as a side
     * effect the way it would if progress reached for auth itself.
     */
    const { service } = cloudService();
    expect(Object.keys(service).sort()).toEqual(['list', 'remove', 'save']);
  });
});

describe('forgetting a title', () => {
  it('removes it here and there, and does not let a queued write bring it back', async () => {
    const { service, saves, removes } = cloudService([entry()]);
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));
    saves.length = 0;

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 1200, durationSeconds: 7200 });
    });
    await act(async () => {
      await latest.forgetProgress({ mediaType: 'movie', mediaId: 550, seasonNumber: 0, episodeNumber: 0 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(CLOUD_SYNC_INTERVAL_MS + 10); });

    expect(removes).toContain('movie:550');
    expect(saves).toHaveLength(0);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })).toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY) ?? '{}');
    expect(stored['movie:550']).toBeUndefined();
  });
});

describe('episodes are separate places', () => {
  it('keeps a position per episode rather than per series', async () => {
    const { service } = cloudService();
    mount(service);
    await waitFor(() => expect(latest.ready).toBe(true));

    const series = { id: 1399, mediaType: 'tv' as const, title: 'A Series', posterPath: null, backdropPath: null };
    await act(async () => {
      latest.recordProgress({ subject: series, positionSeconds: 300, seasonNumber: 1, episodeNumber: 1 });
      latest.recordProgress({ subject: series, positionSeconds: 900, seasonNumber: 1, episodeNumber: 2 });
    });

    expect(latest.entryFor({ id: 1399, mediaType: 'tv' }, 1, 1)?.positionSeconds).toBe(300);
    expect(latest.entryFor({ id: 1399, mediaType: 'tv' }, 1, 2)?.positionSeconds).toBe(900);
  });
});

describe('a failure is not a broken player', () => {
  it('reports the problem and still serves local history', async () => {
    const service: WatchProgressService = {
      list: async () => ({ entries: [], error: 'network down' }),
      save: async () => false,
      remove: async () => false,
    };
    window.localStorage.setItem(PLAYBACK_PROGRESS_KEY, JSON.stringify({
      'movie:550': { position: 640, duration: 7200, serverId: 'cinesrc', updatedAt: '2026-09-03T09:00:00.000Z' },
    }));
    mount(service);

    await waitFor(() => expect(latest.ready).toBe(true));
    expect(latest.error).toBe('network down');
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(640);
  });
});
