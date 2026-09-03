import { describe, expect, it } from 'vitest';
import {
  FREE_ENTITLEMENT,
  PREMIUM_ENTITLEMENT,
  isNewerProviderState,
  subscriptionStateToEntitlement,
  type NormalizedSubscription,
} from '../supabase/functions/_shared/entitlements.ts';

/*
 * The V1 subscription policy, asserted status by status.
 *
 * This is the only place a Stripe status becomes an entitlement, so these are
 * the tests that stop the policy drifting - including the deliberate calls
 * (past_due stays Premium, unknown statuses do not).
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const FUTURE = '2026-10-01T00:00:00.000Z';
const PAST = '2026-08-01T00:00:00.000Z';

function subscription(over: Partial<NormalizedSubscription> = {}): NormalizedSubscription {
  return {
    provider: 'stripe',
    providerSubscriptionId: 'sub_1',
    providerCustomerId: 'cus_1',
    status: 'active',
    priceId: 'price_premium_monthly',
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    providerUpdatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

describe('subscription status to entitlement', () => {
  it.each([
    ['active', PREMIUM_ENTITLEMENT],
    ['trialing', PREMIUM_ENTITLEMENT],
    ['past_due', PREMIUM_ENTITLEMENT],
    ['unpaid', FREE_ENTITLEMENT],
    ['incomplete', FREE_ENTITLEMENT],
    ['incomplete_expired', FREE_ENTITLEMENT],
    ['canceled', FREE_ENTITLEMENT],
    ['paused', FREE_ENTITLEMENT],
  ] as const)('maps %s correctly', (status, expected) => {
    expect(subscriptionStateToEntitlement(subscription({ status }), NOW)).toEqual(expected);
  });

  it('keeps past_due on Premium while Stripe retries the renewal', () => {
    /*
     * Deliberate: one failed renewal attempt does not cost a paying member
     * their membership. Stripe moving on to unpaid or canceled is what
     * downgrades them, and both of those map to free above.
     */
    expect(subscriptionStateToEntitlement(subscription({ status: 'past_due' }), NOW).tier).toBe('premium');
    expect(subscriptionStateToEntitlement(subscription({ status: 'unpaid' }), NOW).tier).toBe('free');
  });

  it('treats a status it has never heard of as free', () => {
    for (const status of ['', 'ACTIVE', 'active ', 'premium', 'grandfathered', 'unknown']) {
      expect(subscriptionStateToEntitlement(subscription({ status }), NOW).tier).toBe('free');
    }
  });

  it('resolves a missing subscription to free with ads on', () => {
    expect(subscriptionStateToEntitlement(null, NOW)).toEqual(FREE_ENTITLEMENT);
    expect(subscriptionStateToEntitlement(undefined, NOW)).toEqual(FREE_ENTITLEMENT);
  });

  it('always pairs premium with ads off and free with ads on', () => {
    expect(PREMIUM_ENTITLEMENT).toEqual({ tier: 'premium', ads_enabled: false });
    expect(FREE_ENTITLEMENT).toEqual({ tier: 'free', ads_enabled: true });
  });
});

describe('cancellation', () => {
  it('keeps Premium until the period ends when cancellation is scheduled', () => {
    const scheduled = subscription({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: FUTURE });
    expect(subscriptionStateToEntitlement(scheduled, NOW).tier).toBe('premium');
  });

  it('drops the same subscription to free once that period has passed', () => {
    /*
     * The clock decides, not the arrival of another webhook. A cancellation
     * notice that never lands must not leave somebody entitled forever.
     */
    const scheduled = subscription({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: PAST });
    expect(subscriptionStateToEntitlement(scheduled, NOW).tier).toBe('free');
  });

  it('drops a scheduled cancellation with no period end at all to free', () => {
    const broken = subscription({ status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: null });
    expect(subscriptionStateToEntitlement(broken, NOW).tier).toBe('free');
  });

  it('does not punish a renewing subscription for a late renewal webhook', () => {
    /*
     * A renewing subscription whose stored period end has just passed means
     * the renewal event is in flight, not that the member stopped paying.
     * Cutting them off over delivery lag would be a false downgrade.
     */
    const renewing = subscription({ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: PAST });
    expect(subscriptionStateToEntitlement(renewing, NOW).tier).toBe('premium');
  });

  it('returns Premium on reactivation', () => {
    const reactivated = subscription({ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: FUTURE });
    expect(subscriptionStateToEntitlement(reactivated, NOW).tier).toBe('premium');
  });
});

describe('out-of-order provider state', () => {
  it('accepts a newer event', () => {
    expect(isNewerProviderState('2026-09-02T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(true);
  });

  it('rejects an older event', () => {
    expect(isNewerProviderState('2026-08-31T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(false);
  });

  it('accepts an event with the same timestamp', () => {
    // Stripe can emit more than one event for an object in the same second;
    // re-applying identical state is harmless, dropping a real change is not.
    expect(isNewerProviderState('2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')).toBe(true);
  });

  it('accepts anything when nothing is stored yet', () => {
    expect(isNewerProviderState('2026-09-01T00:00:00Z', null)).toBe(true);
  });

  it('refuses to overwrite when the incoming event has no usable timestamp', () => {
    expect(isNewerProviderState(null, '2026-09-01T00:00:00Z')).toBe(false);
    expect(isNewerProviderState('not-a-date', '2026-09-01T00:00:00Z')).toBe(false);
  });
});
