import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { AccountProvider } from '../src/components/AccountProvider';
import { WatchProgressProvider, useWatchProgress, type WatchProgressState } from '../src/components/WatchProgressProvider';
import { PLAYBACK_PROGRESS_KEY } from '../src/lib/playbackProgress';
import { entryKey, reconcileProgress, type ProgressEntry } from '../src/lib/watchProgress';
import { entryToRow, rowToEntry, type WatchProgressService } from '../src/lib/watchProgressService';
import type { AccountService } from '../src/lib/accountService';
import { FREE_ENTITLEMENTS, type GlockTvAccount } from '../src/lib/account';
import migration from '../supabase/migrations/20260903190000_watch_progress.sql?raw';
import serviceSource from '../src/lib/watchProgressService.ts?raw';

/*
 * Two boundaries this codebase claimed before it enforced them.
 *
 * The first: reconciliation treats a cloud timestamp as the database's clock
 * and therefore trustworthy, but the client used to upload that value itself.
 * A device with a wrong or hostile clock could write a future updated_at once
 * and then win every comparison forever, wearing authority it did not have.
 *
 * The second: cloud progress is a protected account's benefit, but the
 * eligibility check only asked whether a session existed - and the watch party
 * mints anonymous sessions, so guests qualified.
 */

const statements = migration.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const protectedAccount: GlockTvAccount = { id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null };
const anonymousAccount: GlockTvAccount = { id: 'user-a', email: null, isAnonymous: true, createdAt: null };

const movie = { id: 550, mediaType: 'movie' as const, title: 'Fight Club', posterPath: null, backdropPath: null };

function entry(overrides: Partial<ProgressEntry> = {}): ProgressEntry {
  return {
    mediaType: 'movie', mediaId: 550, seasonNumber: 0, episodeNumber: 0,
    positionSeconds: 600, durationSeconds: 7200, completed: false, providerId: 'cinesrc',
    title: 'Fight Club', posterPath: null, backdropPath: null,
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function cloudService(seed: ProgressEntry[] = []) {
  const rows = new Map(seed.map((row) => [entryKey(row), row]));
  const saves: ProgressEntry[] = [];
  const removes: string[] = [];
  const service: WatchProgressService = {
    list: async () => ({ entries: [...rows.values()], error: '' }),
    save: async (row) => { saves.push(row); rows.set(entryKey(row), row); return true; },
    remove: async (identity) => { removes.push(entryKey(identity)); return true; },
  };
  return { service, saves, removes };
}

/* An account layer whose answer can change, so protecting a guest account is a
   real transition rather than two separate mounts. */
function mutableAccountService(initial: GlockTvAccount | null) {
  let account = initial;
  let notify = () => {};
  const service: AccountService = {
    loadAccount: async () => account,
    loadEntitlements: async () => ({ entitlements: FREE_ENTITLEMENTS, error: '' }),
    linkEmail: async () => {},
    sendSignInLink: async () => {},
    onAuthChange: (listener) => { notify = listener; return () => {}; },
  };
  return {
    service,
    protect: (next: GlockTvAccount) => { account = next; notify(); },
  };
}

let latest: WatchProgressState;
function Probe() { latest = useWatchProgress(); return null; }

function mount(accountService: AccountService, service: WatchProgressService | null) {
  return render(
    <AccountProvider service={accountService}>
      <WatchProgressProvider service={service}>
        <Probe />
      </WatchProgressProvider>
    </AccountProvider>,
  );
}

const seedLocal = (updatedAt: string, position = 800) => window.localStorage.setItem(
  PLAYBACK_PROGRESS_KEY,
  JSON.stringify({ 'movie:550': { position, duration: 7200, serverId: 'cinesrc', updatedAt, title: 'Fight Club' } }),
);

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. no session at all', () => {
  it('records to the device and never to the network', async () => {
    const { service, saves } = cloudService();
    mount(mutableAccountService(null).service, service);
    await waitFor(() => expect(latest.ready).toBe(true));

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 450, durationSeconds: 7200, flush: true });
    });

    expect(saves).toHaveLength(0);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(450);
    expect(JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY)!)['movie:550'].position).toBe(450);
  });
});

describe('2. an anonymous Supabase session', () => {
  it('is still a guest: local only, no cloud write', async () => {
    /*
     * The case the previous check missed. The watch party mints an anonymous
     * user the moment somebody opens a room, so "has a session" was true for
     * ordinary guests and their progress was going to the database.
     */
    const { service, saves } = cloudService();
    mount(mutableAccountService(anonymousAccount).service, service);
    await waitFor(() => expect(latest.ready).toBe(true));

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 700, durationSeconds: 7200, flush: true });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(saves).toHaveLength(0);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(700);
  });

  it('does not upload a guest\'s existing device history either', async () => {
    seedLocal(new Date().toISOString());
    const { service, saves } = cloudService();
    mount(mutableAccountService(anonymousAccount).service, service);

    await waitFor(() => expect(latest.ready).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(saves).toHaveLength(0);
    /* And the history is still there - nothing was deleted to enforce this. */
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(800);
  });

  it('forgets a title locally without needing the cloud', async () => {
    seedLocal(new Date().toISOString());
    const { service, removes } = cloudService();
    mount(mutableAccountService(anonymousAccount).service, service);
    await waitFor(() => expect(latest.ready).toBe(true));

    await act(async () => {
      await latest.forgetProgress({ mediaType: 'movie', mediaId: 550, seasonNumber: 0, episodeNumber: 0 });
    });
    expect(removes).toHaveLength(0);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PLAYBACK_PROGRESS_KEY)!)['movie:550']).toBeUndefined();
  });
});

describe('3. an anonymous caller is refused by the database, not only by the client', () => {
  it('carries the guard on both write policies', () => {
    /*
     * The client check avoids requests it knows will fail. This is what makes
     * the boundary true for a modified client posting straight to PostgREST
     * with the same publishable key every visitor holds.
     */
    for (const name of ['Viewers record their own progress', 'Viewers update their own progress']) {
      const policy = statements.slice(statements.indexOf(`create policy "${name}"`));
      const body = policy.slice(0, policy.indexOf(';') + 1);
      expect(body).toMatch(/auth\.jwt\(\) ->> 'is_anonymous'/);
      expect(body).toMatch(/coalesce\(\(select auth\.jwt\(\) ->> 'is_anonymous'\)::boolean, false\) = false/);
    }
  });

  it('defaults to permitting when the claim is absent, so an ordinary account is unaffected', () => {
    /* coalesce(..., false) - a missing claim reads as "not anonymous", which is
       what a normal signed-in token looks like. The guard must not lock out
       every real user to keep guests out. */
    expect(statements).not.toMatch(/coalesce\(\(select auth\.jwt\(\) ->> 'is_anonymous'\)::boolean, true\)/);
  });

  it('still refuses another account\'s row', () => {
    const writePolicies = [...statements.matchAll(/create policy "Viewers (record|update|forget)[^"]*"[\s\S]*?;/g)]
      .map((match) => match[0]);
    expect(writePolicies).toHaveLength(3);
    for (const policy of writePolicies) {
      expect(policy).toMatch(/user_id = \(select auth\.uid\(\)\)/);
    }
  });
});

describe('4. a protected account syncs', () => {
  it('reads the cloud and writes to it', async () => {
    const { service, saves } = cloudService([entry({ positionSeconds: 4000, updatedAt: '2026-09-02T09:00:00.000Z' })]);
    mount(mutableAccountService(protectedAccount).service, service);

    await waitFor(() => expect(latest.ready).toBe(true));
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(4000);

    await act(async () => {
      latest.recordProgress({ subject: movie, positionSeconds: 5000, durationSeconds: 7200, flush: true });
    });
    expect(saves.at(-1)?.positionSeconds).toBe(5000);
  });
});

describe('5. protecting a guest account', () => {
  it('keeps the local history and makes it eligible under the same identity', async () => {
    /*
     * The transition that has to cost nothing. Supabase keeps the same uid when
     * an email is attached, so the rows this device already holds sync up under
     * the identity they were always keyed to - nothing migrated, nothing
     * deleted, and the uid Friends depends on is untouched.
     */
    seedLocal(new Date().toISOString(), 800);
    const { service, saves } = cloudService();
    const accounts = mutableAccountService(anonymousAccount);
    mount(accounts.service, service);

    await waitFor(() => expect(latest.ready).toBe(true));
    expect(saves).toHaveLength(0);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(800);

    await act(async () => { accounts.protect(protectedAccount); });

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect(saves[0].positionSeconds).toBe(800);
    /* Same identity throughout: nothing here re-keys or re-mints anything. */
    expect(anonymousAccount.id).toBe(protectedAccount.id);
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(800);
  });
});

describe('6. a forged future timestamp cannot become authoritative cloud state', () => {
  const absurd = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

  it('is never uploaded in the first place', () => {
    /*
     * The row a client can build carries no updated_at at all. Its own idea of
     * when it saw this goes to observed_at, which nothing compares.
     */
    const row = entryToRow(entry({ updatedAt: absurd }), 'user-a') as Record<string, unknown>;
    expect(row).not.toHaveProperty('updated_at');
    expect(row.observed_at).toBe(absurd);
  });

  it('is overwritten by the database even if a client posts one directly', () => {
    /*
     * The guarantee, at the boundary that actually holds it. The column default
     * would not be enough - it applies only when the value is omitted, and a
     * modified client posting to PostgREST would simply name it.
     */
    const trigger = statements.slice(
      statements.indexOf('create or replace function public.stamp_watch_progress_updated_at'),
      statements.indexOf('drop trigger if exists watch_progress_stamp_updated_at'),
    );
    expect(trigger).toMatch(/new\.updated_at := now\(\)/);
    expect(statements).toMatch(/before insert or update on public\.watch_progress/);
  });

  it('is not even a column the browser may name', () => {
    const insertGrant = statements.slice(statements.indexOf('grant insert ('), statements.indexOf('grant update ('));
    const updateGrant = statements.slice(statements.indexOf('grant update ('));
    for (const grant of [insertGrant, updateGrant.slice(0, updateGrant.indexOf(';') + 1)]) {
      expect(grant).not.toMatch(/\bupdated_at\b/);
      expect(grant).toMatch(/\bobserved_at\b/);
    }
    /* And the table-wide grant does not quietly hand back everything. */
    expect(statements).not.toMatch(/grant select, insert, update, delete on public\.watch_progress/);
    expect(statements).toMatch(/grant select, delete on public\.watch_progress to authenticated;/);
  });

  it('loses to real cloud state when it sits on the local side', async () => {
    const { service } = cloudService([entry({ positionSeconds: 4000, updatedAt: '2026-09-02T09:00:00.000Z' })]);
    seedLocal(absurd, 5);
    mount(mutableAccountService(protectedAccount).service, service);

    await waitFor(() => expect(latest.ready).toBe(true));
    /* The device claiming to be a year ahead does not get to pin 5 seconds in
       place across every other device. */
    expect(latest.entryFor({ id: 550, mediaType: 'movie' })?.positionSeconds).toBe(4000);
  });

  it('cannot be laundered into authority by a round trip', () => {
    /*
     * The shape of the original defect: upload a forged stamp, read it back,
     * and it now looks like database state. What comes back is whatever the
     * database stamped, so the forged value is simply not there to be believed.
     */
    const stamped = rowToEntry({
      media_type: 'movie', media_id: 550, season_number: 0, episode_number: 0,
      position_seconds: 5, duration_seconds: 7200, completed: false,
      title: 'Fight Club', updated_at: '2026-09-02T09:00:00.000Z', observed_at: absurd,
    })!;
    expect(stamped.updatedAt).toBe('2026-09-02T09:00:00.000Z');
    expect(stamped.observedAt).toBe(absurd);

    const local = entry({ positionSeconds: 4000, updatedAt: '2026-09-02T10:00:00.000Z' });
    /* observedAt takes no part in the decision, so the newer honest local
       record still wins on its own merits. */
    expect(reconcileProgress(local, stamped, Date.parse('2026-09-02T11:00:00.000Z'))?.positionSeconds).toBe(4000);
  });

  it('does not let the client send a stamp by another name', () => {
    expect(serviceSource).not.toMatch(/updated_at:\s*entry\./);
  });
});

describe('7. cross-user boundaries are unchanged', () => {
  it('keeps every policy scoped to the caller', () => {
    const policies = [...statements.matchAll(/create policy "[^"]+"[\s\S]*?;/g)].map((match) => match[0]);
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(policy).toMatch(/user_id = \(select auth\.uid\(\)\)/);
    }
    expect(statements).toMatch(/alter table public\.watch_progress enable row level security/);
  });

  it('adds no privileged path while fixing the timestamp', () => {
    /* The trigger is an ordinary one: it rewrites NEW and needs no elevation.
       A SECURITY DEFINER here would be a new privileged surface for a problem
       that does not require one. */
    expect(statements).not.toMatch(/security definer/i);
    expect(statements).not.toMatch(/service_role/);
  });

  it('never grants anything to the signed-out role', () => {
    for (const grant of statements.split('\n').filter((line) => line.trim().startsWith('grant '))) {
      expect(grant).not.toMatch(/\bto anon\b/);
    }
  });
});

describe('8. Friends is untouched by any of this', () => {
  it('still shares no table, column or channel with room playback', () => {
    for (const roomTable of ['watch_rooms', 'room_members', 'chat_messages']) {
      expect(statements).not.toContain(roomTable);
    }
    expect(serviceSource).not.toMatch(/watch_rooms|room_members|playback_position|host_id/);
    expect(serviceSource).not.toMatch(/\.channel\(|postgres_changes/);
  });
});
