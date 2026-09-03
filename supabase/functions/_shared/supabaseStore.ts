import type { EntitlementRecord, NormalizedSubscription } from './entitlements.ts';
import type { BillingStore } from './billingStore.ts';

/*
 * BillingStore over Supabase's REST API, using the service-role key.
 *
 * Plain fetch rather than the JS client: these are six small queries, and
 * keeping the dependency out means the same file type-checks in the repo's
 * toolchain and runs unchanged on Deno.
 *
 * The key is read from the server environment by the caller and never leaves
 * this module's request headers.
 */
export function createSupabaseBillingStore({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): BillingStore {
  const rest = `${supabaseUrl.replace(/\/+$/, '')}/rest/v1`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  async function select<T>(path: string): Promise<T[]> {
    const response = await fetchImpl(`${rest}${path}`, { headers });
    if (!response.ok) throw new Error(`Billing read failed (${response.status}).`);
    return await response.json() as T[];
  }

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`${rest}/rpc/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`Billing write failed (${response.status}).`);
    return await response.json() as T;
  }

  async function upsert(table: string, row: unknown, onConflict: string): Promise<void> {
    const response = await fetchImpl(`${rest}/${table}?on_conflict=${onConflict}`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
    if (!response.ok) throw new Error(`Billing write failed (${response.status}).`);
  }

  return {
    async getCustomerByUser(userId) {
      const rows = await select<{ provider_customer_id: string }>(
        `/billing_customers?user_id=eq.${encodeURIComponent(userId)}&select=provider_customer_id&limit=1`,
      );
      return rows[0] ? { providerCustomerId: rows[0].provider_customer_id } : null;
    },

    async getUserByCustomer(providerCustomerId) {
      if (!providerCustomerId) return null;
      const rows = await select<{ user_id: string }>(
        `/billing_customers?provider_customer_id=eq.${encodeURIComponent(providerCustomerId)}&select=user_id&limit=1`,
      );
      return rows[0] ? { userId: rows[0].user_id } : null;
    },

    async saveCustomer({ userId, providerCustomerId }) {
      await upsert('billing_customers', {
        user_id: userId,
        provider: 'stripe',
        provider_customer_id: providerCustomerId,
      }, 'user_id');
    },

    /*
     * One database call. The event claim, the ordering comparison and both
     * writes happen inside apply_billing_provider_state, so concurrent
     * invocations serialize on the row lock rather than racing between
     * separate REST requests.
     */
    async applyProviderState({ userId, subscription, entitlement, event }: {
      userId: string;
      subscription: NormalizedSubscription;
      entitlement: EntitlementRecord;
      event: { providerEventId: string; eventType: string; providerCreatedAt: string | null };
    }) {
      const outcome = await rpc<string>('apply_billing_provider_state', {
        p_user_id: userId,
        p_provider: subscription.provider,
        p_subscription_id: subscription.providerSubscriptionId,
        p_customer_id: subscription.providerCustomerId,
        p_status: subscription.status,
        p_price_id: subscription.priceId,
        p_current_period_end: subscription.currentPeriodEnd,
        p_cancel_at_period_end: subscription.cancelAtPeriodEnd,
        p_provider_updated_at: subscription.providerUpdatedAt,
        /* An explicit free row rather than a delete: for a member who has ever
           paid, "downgraded on this date" is worth keeping. */
        p_tier: entitlement.tier,
        p_ads_enabled: entitlement.ads_enabled,
        p_event_id: event.providerEventId,
        p_event_type: event.eventType,
        p_event_created_at: event.providerCreatedAt,
      });

      /* Anything the function does not recognise is treated as not applied. */
      return outcome === 'applied' || outcome === 'stale' || outcome === 'replay' ? outcome : 'stale';
    },

    async markEventProcessed({ providerEventId, eventType, providerCreatedAt }) {
      await upsert('billing_webhook_events', {
        provider_event_id: providerEventId,
        event_type: eventType,
        provider_created_at: providerCreatedAt,
      }, 'provider_event_id');
    },
  };
}

/*
 * Resolves the caller from their Supabase JWT by asking Supabase who the token
 * belongs to. The request body is never consulted: a user id sent by a caller
 * is a claim, not an identity.
 */
export async function authenticateRequest({
  supabaseUrl,
  anonOrServiceKey,
  authorizationHeader,
  fetchImpl = fetch,
}: {
  supabaseUrl: string;
  anonOrServiceKey: string;
  authorizationHeader: string | null;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}): Promise<{ id: string; email: string | null; isAnonymous: boolean } | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;

  const response = await fetchImpl(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
    headers: { apikey: anonOrServiceKey, Authorization: authorizationHeader },
  });
  if (!response.ok) return null;

  const user = await response.json().catch(() => null) as
    | { id?: string; email?: string | null; is_anonymous?: boolean }
    | null;
  if (!user?.id) return null;

  return { id: user.id, email: user.email ?? null, isAnonymous: user.is_anonymous === true };
}
