/*
 * The one place a Stripe subscription becomes a GlockTV entitlement.
 *
 * Every webhook branch funnels through subscriptionStateToEntitlement, so
 * there is a single policy to read, change and audit rather than a status
 * check scattered across event handlers that can drift apart.
 *
 * Pure: no Stripe client, no database, no Deno. It takes normalized state and
 * the current time and returns rows.
 */

export type EntitlementTier = 'free' | 'premium';

export interface EntitlementRecord {
  /* Snake case because this is written straight into account_entitlements. */
  tier: EntitlementTier;
  ads_enabled: boolean;
}

export const FREE_ENTITLEMENT: EntitlementRecord = { tier: 'free', ads_enabled: true };
export const PREMIUM_ENTITLEMENT: EntitlementRecord = { tier: 'premium', ads_enabled: false };

/* Stripe's subscription shape, reduced to what the policy actually needs. */
export interface NormalizedSubscription {
  provider: 'stripe';
  providerSubscriptionId: string;
  providerCustomerId: string;
  /* Raw provider status, lowercased. Unknown values are allowed through and
     resolve to free, so a status Stripe adds later cannot grant Premium. */
  status: string;
  priceId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /* When the provider last changed this object. The out-of-order guard uses
     it; it is not part of the entitlement decision. */
  providerUpdatedAt: string | null;
}

/*
 * V1 policy, stated once.
 *
 * active, trialing  -> Premium. Paid and in good standing.
 * past_due          -> Premium, deliberately. Stripe is still retrying the
 *                      renewal, and taking a paying member's Premium away on
 *                      the first failed attempt is worse than carrying them
 *                      for the retry window. Stripe moving the subscription on
 *                      to unpaid or canceled is what downgrades them.
 * unpaid, incomplete, incomplete_expired, canceled, paused -> Free.
 * anything else     -> Free. A status this build has never heard of is not
 *                      evidence of payment.
 */
const ENTITLED_STATUSES = new Set(['active', 'trialing', 'past_due']);

export function subscriptionStateToEntitlement(
  subscription: NormalizedSubscription | null | undefined,
  now: Date = new Date(),
): EntitlementRecord {
  if (!subscription) return FREE_ENTITLEMENT;
  if (!ENTITLED_STATUSES.has(subscription.status)) return FREE_ENTITLEMENT;

  /*
   * A subscription set to cancel will not renew, so its period end is a real
   * expiry rather than a renewal date, and access stops there. Checking the
   * clock rather than waiting to be told means a webhook that never arrives
   * cannot leave someone entitled forever.
   *
   * The same check is deliberately NOT applied to a subscription that is still
   * renewing: there, a period end in the past means the renewal webhook is
   * late, and cutting off a paying member over a few seconds of delivery lag
   * would be a false downgrade.
   */
  if (subscription.cancelAtPeriodEnd) {
    const endsAt = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : NaN;
    if (!Number.isFinite(endsAt) || now.getTime() >= endsAt) return FREE_ENTITLEMENT;
  }

  return PREMIUM_ENTITLEMENT;
}

/*
 * Whether an incoming provider event describes a newer state than what is
 * already stored. Webhook delivery is not ordered, so an older event can
 * arrive after a newer one and must not be allowed to undo it.
 *
 * Unknown incoming time is treated as not newer: without a timestamp there is
 * no evidence this event supersedes what is stored, and refusing to overwrite
 * is the safe direction.
 */
export function isNewerProviderState(
  incomingUpdatedAt: string | null | undefined,
  storedUpdatedAt: string | null | undefined,
): boolean {
  const incoming = incomingUpdatedAt ? Date.parse(incomingUpdatedAt) : NaN;
  if (!Number.isFinite(incoming)) return false;

  const stored = storedUpdatedAt ? Date.parse(storedUpdatedAt) : NaN;
  /* Nothing stored yet, so anything with a real timestamp is newer. */
  if (!Number.isFinite(stored)) return true;

  /* Equal timestamps are allowed through: Stripe can emit more than one event
     for the same object second, and re-applying identical state is harmless
     while dropping a real change is not. */
  return incoming >= stored;
}
