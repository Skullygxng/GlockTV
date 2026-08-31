import { describe, expect, it, vi } from 'vitest';
import {
  FREE_ENTITLEMENTS,
  entitlementsFromRow,
  isSignedIn,
  shouldShowAds,
  type Entitlements,
} from '../src/lib/account';
import { createAccountService } from '../src/lib/accountService';
import migration from '../supabase/migrations/20260901000000_account_entitlements.sql?raw';

/*
 * The entitlement rules, and the proof that no browser path can write one.
 *
 * Everything here is about one property: a user with DevTools open must not be
 * able to become Premium. That is defended in three independent places - the
 * pure resolver, the service surface, and the SQL grant - and each is checked
 * on its own so removing any one of them fails a test.
 */

describe('entitlement resolution fails closed', () => {
  it('resolves an account with no entitlement row to free with ads on', () => {
    expect(entitlementsFromRow(null)).toEqual({ tier: 'free', adsEnabled: true });
    expect(entitlementsFromRow(undefined)).toEqual({ tier: 'free', adsEnabled: true });
    expect(FREE_ENTITLEMENTS).toEqual({ tier: 'free', adsEnabled: true });
  });

  it('resolves a premium row to premium with ads off', () => {
    expect(entitlementsFromRow({ tier: 'premium', ads_enabled: true }))
      .toEqual({ tier: 'premium', adsEnabled: false });
  });

  it('treats anything that is not exactly premium as free', () => {
    for (const tier of ['Premium', 'PREMIUM', 'pro', 'premium ', '', null, undefined, 1, true, {}]) {
      expect(entitlementsFromRow({ tier, ads_enabled: false }).tier).toBe('free');
    }
  });

  it('lets a free account have ads turned off without becoming premium', () => {
    // Support can suppress ads for one account; that is not a tier change.
    const result = entitlementsFromRow({ tier: 'free', ads_enabled: false });
    expect(result).toEqual({ tier: 'free', adsEnabled: false });
  });

  it('defaults ads on when the row does not say', () => {
    expect(entitlementsFromRow({ tier: 'free' }).adsEnabled).toBe(true);
    expect(entitlementsFromRow({ tier: 'free', ads_enabled: 'no' }).adsEnabled).toBe(true);
  });
});

describe('ad policy', () => {
  it('shows ads to free, hides them from premium', () => {
    expect(shouldShowAds({ tier: 'free', adsEnabled: true })).toBe(true);
    expect(shouldShowAds({ tier: 'premium', adsEnabled: false })).toBe(false);
  });

  it('shows ads whenever the answer is unknown', () => {
    expect(shouldShowAds(null)).toBe(true);
    expect(shouldShowAds(undefined)).toBe(true);
  });

  it('never hides ads for a free tier, whatever the row claimed', () => {
    // adsEnabled false on a free tier suppresses the slot, but the tier check
    // is what grants ad-free status, and free is never ad-free by tier.
    const sneaky = { tier: 'free', adsEnabled: false } as Entitlements;
    expect(shouldShowAds(sneaky)).toBe(true);
  });
});

describe('account service entitlement reads', () => {
  function client(overrides: Record<string, unknown> = {}) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: { tier: 'premium', ads_enabled: false }, error: null });
    const select = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select }));
    return {
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'u1', email: null, is_anonymous: true, created_at: '2026-01-01' } }, error: null }),
        updateUser: vi.fn().mockResolvedValue({ error: null }),
        signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
        onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      },
      from,
      select,
      maybeSingle,
      ...overrides,
    };
  }

  it('reads a premium entitlement from the server', async () => {
    const fake = client();
    const service = createAccountService(fake as never);

    expect(await service.loadEntitlements()).toEqual({
      entitlements: { tier: 'premium', adsEnabled: false },
      error: '',
    });
    expect(fake.from).toHaveBeenCalledWith('account_entitlements');
  });

  it('falls back to free with ads on when the fetch errors', async () => {
    const fake = client();
    fake.maybeSingle.mockResolvedValue({ data: null, error: { message: 'network down' } });
    const service = createAccountService(fake as never);

    const result = await service.loadEntitlements();
    expect(result.entitlements).toEqual({ tier: 'free', adsEnabled: true });
    expect(result.error).toBe('network down');
  });

  it('falls back to free with ads on when the request throws', async () => {
    const fake = client();
    fake.maybeSingle.mockRejectedValue(new Error('offline'));
    const service = createAccountService(fake as never);

    const result = await service.loadEntitlements();
    expect(result.entitlements).toEqual({ tier: 'free', adsEnabled: true });
    expect(result.error).toBe('offline');
  });

  it('falls back to free with ads on when there is no row', async () => {
    const fake = client();
    fake.maybeSingle.mockResolvedValue({ data: null, error: null });
    const service = createAccountService(fake as never);

    expect((await service.loadEntitlements()).entitlements).toEqual({ tier: 'free', adsEnabled: true });
  });

  it('exposes no way for the client to write an entitlement', async () => {
    const fake = client();
    const service = createAccountService(fake as never);

    /*
     * The service surface is the whole API the app has. If a mutation ever
     * appears here it is reachable from a browser console, so the shape itself
     * is the assertion.
     */
    expect(Object.keys(service).sort()).toEqual([
      'linkEmail', 'loadAccount', 'loadEntitlements', 'onAuthChange', 'sendSignInLink',
    ]);
    for (const name of Object.keys(service)) {
      expect(/premium|tier|entitle.*(set|update|grant)|upgrade/i.test(name)).toBe(false);
    }

    await service.loadEntitlements();
    // The only thing it ever does to that table is select.
    expect(fake.select).toHaveBeenCalledWith('tier, ads_enabled');
    const table = fake.from.mock.results[0].value as Record<string, unknown>;
    for (const writer of ['insert', 'update', 'upsert', 'delete']) {
      expect(table[writer]).toBeUndefined();
    }
  });
});

describe('entitlement migration keeps write authority on the server', () => {
  /* Strip SQL comments so prose in the header cannot satisfy a check. */
  const sql = migration.replace(/--[^\n]*/g, '').toLowerCase();

  it('enables row level security on the table', () => {
    expect(sql).toContain('alter table public.account_entitlements enable row level security');
  });

  it('revokes everything before granting anything', () => {
    expect(sql).toMatch(/revoke all on public\.account_entitlements from public, anon, authenticated/);
  });

  it('grants the browser select and nothing else', () => {
    const grants = sql.match(/grant [^;]*on public\.account_entitlements[^;]*;/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toContain('grant select on public.account_entitlements to authenticated');
    for (const writer of ['insert', 'update', 'delete', 'all privileges']) {
      expect(grants[0]).not.toContain(writer);
    }
  });

  it('has exactly one policy, and it is a select of the caller own row', () => {
    const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain('for select to authenticated');
    expect(policies[0]).toContain('user_id = (select auth.uid())');
    // "for all" would silently include insert, update and delete.
    expect(policies[0]).not.toMatch(/for (all|insert|update|delete)\b/);
    expect(policies[0]).not.toContain('with check');
  });

  it('adds no security definer function that could grant a tier', () => {
    // A definer function callable by authenticated users would bypass every
    // grant and policy above.
    expect(sql).not.toContain('security definer');
    expect(sql).not.toContain('create or replace function');
    expect(sql).not.toContain('create function');
  });

  it('defaults a new row to free with ads on', () => {
    expect(sql).toContain("tier text not null default 'free'");
    expect(sql).toContain("check (tier in ('free', 'premium'))");
    expect(sql).toContain('ads_enabled boolean not null default true');
  });

  it('touches no existing table', () => {
    const alters = sql.match(/alter table [a-z_.]+/g) ?? [];
    expect([...new Set(alters)]).toEqual(['alter table public.account_entitlements']);
    expect(sql).not.toContain('drop table');
    expect(sql).not.toContain('truncate');
  });
});

describe('account identity helpers', () => {
  it('treats an anonymous account as not signed in', () => {
    expect(isSignedIn({ id: 'u1', email: null, isAnonymous: true, createdAt: null })).toBe(false);
    expect(isSignedIn(null)).toBe(false);
    expect(isSignedIn({ id: 'u1', email: 'a@b.c', isAnonymous: false, createdAt: null })).toBe(true);
  });
});
