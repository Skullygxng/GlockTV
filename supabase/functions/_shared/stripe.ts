/*
 * The Stripe calls billing needs, over plain fetch.
 *
 * Stripe's REST API takes form-encoded bodies, which is all three of these
 * need, so the SDK would add a dependency and a Deno-vs-Node import split for
 * no gain. fetch is injectable, so the tests drive real code paths rather than
 * a mock of a mock.
 */

export interface StripeSubscriptionObject {
  id: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items?: { data?: Array<{ price?: { id?: string } }> };
  [key: string]: unknown;
}

export interface StripeClient {
  createCustomer(input: { email: string | null; supabaseUserId: string }): Promise<{ id: string }>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    supabaseUserId: string;
  }): Promise<{ id: string; url: string }>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ id: string; url: string }>;
  getSubscription(subscriptionId: string): Promise<StripeSubscriptionObject>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STRIPE_API = 'https://api.stripe.com/v1';

function form(entries: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

export function createStripeClient(secretKey: string, fetchImpl: FetchLike = fetch): StripeClient {
  async function call<T>(path: string, body?: string): Promise<T> {
    const response = await fetchImpl(`${STRIPE_API}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
    });

    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    if (!response.ok) {
      /* Stripe's message describes the request, not the key, so it is safe to
         surface. The key itself never leaves this module. */
      throw new Error(payload?.error?.message ?? `Stripe request failed (${response.status}).`);
    }
    return payload as T;
  }

  return {
    createCustomer: ({ email, supabaseUserId }) => call('/customers', form({
      email: email ?? undefined,
      /* Set by the server from the authenticated identity, never from the
         request body, so it is a trustworthy back-reference. */
      'metadata[supabase_user_id]': supabaseUserId,
    })),

    createCheckoutSession: ({ customerId, priceId, successUrl, cancelUrl, supabaseUserId }) =>
      call('/checkout/sessions', form({
        mode: 'subscription',
        customer: customerId,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        success_url: successUrl,
        cancel_url: cancelUrl,
        'metadata[supabase_user_id]': supabaseUserId,
        'subscription_data[metadata][supabase_user_id]': supabaseUserId,
      })),

    createPortalSession: ({ customerId, returnUrl }) =>
      call('/billing_portal/sessions', form({ customer: customerId, return_url: returnUrl })),

    getSubscription: (subscriptionId) => call(`/subscriptions/${encodeURIComponent(subscriptionId)}`),
  };
}

/* Stripe's subscription object reduced to the fields policy and storage need. */
export function normalizeStripeSubscription(subscription: StripeSubscriptionObject, providerUpdatedAt: string | null) {
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const periodEnd = typeof subscription.current_period_end === 'number'
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  return {
    provider: 'stripe' as const,
    providerSubscriptionId: subscription.id,
    providerCustomerId: customer ?? '',
    status: String(subscription.status ?? '').toLowerCase(),
    priceId: subscription.items?.data?.[0]?.price?.id ?? null,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    providerUpdatedAt,
  };
}
