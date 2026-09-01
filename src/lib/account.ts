/*
 * The GlockTV account model, and the one place that decides what an account is
 * entitled to. Pure - no React, no Supabase - so the rules can be tested
 * directly and so no feature has to invent its own Premium check.
 */

export interface GlockTvAccount {
  id: string;
  email: string | null;
  isAnonymous: boolean;
  createdAt: string | null;
}

export type AccountTier = 'free' | 'premium';

export interface Entitlements {
  tier: AccountTier;
  adsEnabled: boolean;
}

/*
 * What every account gets until a trusted server says otherwise. This is also
 * the answer for "we could not find out": a signed-out visitor, a missing row,
 * a failed request and a request still in flight all land here, so no failure
 * mode can hand out Premium.
 */
export const FREE_ENTITLEMENTS: Entitlements = { tier: 'free', adsEnabled: true };

/* The shape the entitlements table returns. Nothing else is read from it. */
export interface EntitlementRow {
  tier?: unknown;
  ads_enabled?: unknown;
}

/*
 * Translate a server row into entitlements.
 *
 * Premium requires the server to have said so explicitly - the tier must read
 * exactly 'premium'. Anything else at all (null, absent, a typo, a value from
 * a future tier this build does not know) resolves to free, so an unexpected
 * value can only ever cost someone Premium they were not granted, never grant
 * Premium they were not sold.
 *
 * ads_enabled is carried through faithfully from the row, but note what it
 * does NOT do in V1: shouldShowAds keys off the tier alone, so a free account
 * with ads_enabled false is still shown ads. The column is recorded so the
 * server can already express per-account ad suppression, and so a later policy
 * can honour it, without a schema change. Until that policy exists, the only
 * thing that makes an account ad-free is Premium.
 */
export function entitlementsFromRow(row: EntitlementRow | null | undefined): Entitlements {
  if (!row) return FREE_ENTITLEMENTS;

  const tier: AccountTier = row.tier === 'premium' ? 'premium' : 'free';
  if (tier === 'premium') return { tier, adsEnabled: false };

  return { tier, adsEnabled: typeof row.ads_enabled === 'boolean' ? row.ads_enabled : true };
}

/*
 * The single ad-policy boundary. Pages ask this rather than reading a tier and
 * deciding for themselves, so there is one place to change when the ad rules
 * change - and one place to audit.
 *
 * V1 policy is exactly: premium means no ads, everything else means ads. The
 * row's ads_enabled is intentionally not consulted here - see
 * entitlementsFromRow - so there is one condition to audit rather than two
 * that could disagree.
 *
 * It renders nothing and knows about no ad network. Not knowing the answer
 * means ads: a viewer briefly seeing an ad slot they paid to avoid is a bug,
 * while the reverse is lost revenue on every failure.
 */
export function shouldShowAds(entitlements: Entitlements | null | undefined): boolean {
  return entitlements?.tier === 'premium' ? false : true;
}

/* Guests have no id yet; they are still a valid, fully usable GlockTV visitor. */
export function isSignedIn(account: GlockTvAccount | null): boolean {
  return account !== null && !account.isAnonymous;
}
