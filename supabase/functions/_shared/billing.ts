import {
  FREE_ENTITLEMENT,
  subscriptionStateToEntitlement,
  type NormalizedSubscription,
} from './entitlements.ts';
import { normalizeStripeSubscription, type StripeClient, type StripeSubscriptionObject } from './stripe.ts';
import type { BillingStore } from './billingStore.ts';

/*
 * What the three functions actually do, with their dependencies handed in.
 *
 * The Deno entrypoints are thin: they read secrets, build a Stripe client and
 * a store, and call one of these. Everything worth testing - who the caller
 * is, which price is used, whether an event is a replay or is stale - lives
 * here and is exercised directly.
 */

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  isAnonymous: boolean;
}

export type BillingResult =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string };

export async function startCheckout({
  user,
  store,
  stripe,
  priceId,
  successUrl,
  cancelUrl,
}: {
  user: AuthenticatedUser;
  store: BillingStore;
  stripe: StripeClient;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<BillingResult> {
  /*
   * Premium is bought for an identity the buyer can get back to. An anonymous
   * account lives in one browser's storage: selling a subscription against it
   * would mean the first cleared site data loses a paid membership with no way
   * to recover it.
   */
  if (user.isAnonymous) {
    return { ok: false, status: 403, error: 'Protect your account with an email address before subscribing.' };
  }
  if (!priceId) {
    return { ok: false, status: 500, error: 'Premium is not configured yet.' };
  }

  const existing = await store.getCustomerByUser(user.id);
  let customerId = existing?.providerCustomerId ?? '';

  if (!customerId) {
    const customer = await stripe.createCustomer({ email: user.email, supabaseUserId: user.id });
    customerId = customer.id;
    await store.saveCustomer({ userId: user.id, providerCustomerId: customerId });
  }

  const session = await stripe.createCheckoutSession({
    customerId,
    /* The one configured price. There is no code path that takes a price from
       the caller, so there is nothing to forge. */
    priceId,
    successUrl,
    cancelUrl,
    supabaseUserId: user.id,
  });

  return { ok: true, url: session.url };
}

export async function openBillingPortal({
  user,
  store,
  stripe,
  returnUrl,
}: {
  user: AuthenticatedUser;
  store: BillingStore;
  stripe: StripeClient;
  returnUrl: string;
}): Promise<BillingResult> {
  /* The customer comes from the authenticated user's own mapping, so a caller
     cannot open somebody else's billing portal by naming their customer. */
  const existing = await store.getCustomerByUser(user.id);
  if (!existing?.providerCustomerId) {
    return { ok: false, status: 404, error: 'This account has no membership to manage yet.' };
  }

  const session = await stripe.createPortalSession({
    customerId: existing.providerCustomerId,
    returnUrl,
  });
  return { ok: true, url: session.url };
}

/*
 * The Stripe events that can change what somebody is entitled to.
 *
 * Exported because this list is also a configuration instruction: the webhook
 * endpoint in the Stripe dashboard has to be subscribed to exactly these, and
 * the README says so. A test binds the two together so adding a branch here
 * cannot leave the setup instructions quietly wrong.
 */
export const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'checkout.session.completed',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
]);

export interface StripeEvent {
  id: string;
  type: string;
  created?: number;
  data?: { object?: Record<string, unknown> };
}

export type WebhookOutcome =
  | { handled: true; reason: 'applied'; userId: string; tier: string }
  | { handled: false; reason: 'replay' | 'ignored_event' | 'stale' | 'unknown_customer' | 'no_subscription' };

/*
 * Applies one verified Stripe event.
 *
 * Signature verification happens before this is called; nothing here treats an
 * event as trustworthy on its own.
 */
export async function applyStripeEvent({
  event,
  store,
  stripe,
  now = new Date(),
}: {
  event: StripeEvent;
  store: BillingStore;
  stripe: StripeClient;
  now?: Date;
}): Promise<WebhookOutcome> {
  const eventCreatedAt = typeof event.created === 'number'
    ? new Date(event.created * 1000).toISOString()
    : null;

  if (!SUBSCRIPTION_EVENTS.has(event.type)) {
    await store.markEventProcessed({ providerEventId: event.id, eventType: event.type, providerCreatedAt: eventCreatedAt });
    return { handled: false, reason: 'ignored_event' };
  }

  const object = event.data?.object ?? {};

  /*
   * The subscription object is the source of truth, not the event that
   * announced it. A completed checkout session says a payment happened; only
   * the subscription says what the member is entitled to now, so it is
   * re-read from Stripe rather than inferred.
   */
  const subscriptionId = resolveSubscriptionId(object);
  if (!subscriptionId) {
    await store.markEventProcessed({ providerEventId: event.id, eventType: event.type, providerCreatedAt: eventCreatedAt });
    return { handled: false, reason: 'no_subscription' };
  }

  const fresh = await stripe.getSubscription(subscriptionId);
  const subscription = normalizeStripeSubscription(fresh, eventCreatedAt);

  const userId = await resolveUserId(subscription, fresh, store);
  if (!userId) {
    await store.markEventProcessed({ providerEventId: event.id, eventType: event.type, providerCreatedAt: eventCreatedAt });
    return { handled: false, reason: 'unknown_customer' };
  }

  const entitlement = subscriptionStateToEntitlement(subscription, now);

  /*
   * Ordering and replay are both decided by the database, in one statement
   * holding the row lock. Deciding either of them here would be a
   * read-then-write across two REST calls, which two concurrent invocations
   * can interleave - and Stripe both retries and delivers out of order.
   */
  const result = await store.applyProviderState({
    userId,
    subscription,
    entitlement,
    event: { providerEventId: event.id, eventType: event.type, providerCreatedAt: eventCreatedAt },
  });

  if (result === 'replay') return { handled: false, reason: 'replay' };
  if (result === 'stale') return { handled: false, reason: 'stale' };
  return { handled: true, reason: 'applied', userId, tier: entitlement.tier };
}

function resolveSubscriptionId(object: Record<string, unknown>): string | null {
  /* customer.subscription.* events carry the subscription itself; checkout and
     invoice events reference it. */
  if (typeof object.id === 'string' && typeof object.status === 'string' && 'items' in object) return object.id;
  const referenced = object.subscription;
  if (typeof referenced === 'string') return referenced;
  if (referenced && typeof referenced === 'object' && typeof (referenced as { id?: unknown }).id === 'string') {
    return (referenced as { id: string }).id;
  }
  /* A subscription object without items still identifies itself. */
  if (typeof object.id === 'string' && typeof object.status === 'string') return object.id;
  return null;
}

async function resolveUserId(
  subscription: NormalizedSubscription,
  raw: StripeSubscriptionObject,
  store: BillingStore,
): Promise<string | null> {
  /*
   * The local customer mapping is authoritative, because the server wrote it.
   * Stripe metadata is only consulted as a fallback, and only because the
   * server also set it during checkout - it is never taken from a client.
   */
  const mapped = await store.getUserByCustomer(subscription.providerCustomerId);
  if (mapped?.userId) return mapped.userId;

  const metadata = raw.metadata as Record<string, unknown> | undefined;
  const fromMetadata = metadata?.supabase_user_id;
  if (typeof fromMetadata === 'string' && fromMetadata) {
    /* Record the mapping so later events do not depend on metadata at all. */
    await store.saveCustomer({ userId: fromMetadata, providerCustomerId: subscription.providerCustomerId });
    return fromMetadata;
  }
  return null;
}

/* Re-exported so callers have one import for the policy they are applying. */
export { FREE_ENTITLEMENT, subscriptionStateToEntitlement };
