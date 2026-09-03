import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  signStripePayload,
  verifyStripeSignature,
} from '../supabase/functions/_shared/stripeSignature.ts';
import { applyStripeEvent, openBillingPortal, startCheckout, type StripeEvent } from '../supabase/functions/_shared/billing.ts';
import type { BillingStore } from '../supabase/functions/_shared/billingStore.ts';
import type { StripeClient, StripeSubscriptionObject } from '../supabase/functions/_shared/stripe.ts';

/*
 * The security properties of the billing server, exercised through the real
 * code paths rather than asserted about the source.
 *
 * The one property everything here defends: a browser can ask to be billed,
 * and nothing else. Premium arrives only because a signed Stripe webhook said
 * so, and only for the account Stripe named.
 */

const SECRET = 'whsec_test_secret';
const NOW = new Date('2026-09-01T12:00:00.000Z');

/* An in-memory BillingStore that behaves like the real tables. */
function makeStore() {
  const customers = new Map<string, string>();      // userId -> customerId
  const byCustomer = new Map<string, string>();     // customerId -> userId
  const subscriptions = new Map<string, { providerUpdatedAt: string | null; status: string }>();
  const entitlements = new Map<string, { tier: string; ads_enabled: boolean }>();
  const events = new Set<string>();
  const writes: string[] = [];

  const store: BillingStore = {
    async getCustomerByUser(userId) {
      const id = customers.get(userId);
      return id ? { providerCustomerId: id } : null;
    },
    async getUserByCustomer(customerId) {
      const userId = byCustomer.get(customerId);
      return userId ? { userId } : null;
    },
    async saveCustomer({ userId, providerCustomerId }) {
      writes.push(`customer:${userId}`);
      customers.set(userId, providerCustomerId);
      byCustomer.set(providerCustomerId, userId);
    },
    async getSubscription(userId) {
      return subscriptions.get(userId) ?? null;
    },
    async saveSubscription({ userId, subscription }) {
      writes.push(`subscription:${userId}:${subscription.status}`);
      subscriptions.set(userId, {
        providerUpdatedAt: subscription.providerUpdatedAt,
        status: subscription.status,
      });
    },
    async saveEntitlement({ userId, entitlement }) {
      writes.push(`entitlement:${userId}:${entitlement.tier}`);
      entitlements.set(userId, entitlement);
    },
    async hasProcessedEvent(id) {
      return events.has(id);
    },
    async markEventProcessed({ providerEventId }) {
      events.add(providerEventId);
    },
  };

  return { store, customers, byCustomer, subscriptions, entitlements, events, writes };
}

function stripeSubscription(over: Partial<StripeSubscriptionObject> = {}): StripeSubscriptionObject {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000),
    items: { data: [{ price: { id: 'price_premium_monthly' } }] },
    ...over,
  };
}

function makeStripe(subscription: StripeSubscriptionObject = stripeSubscription()) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const client: StripeClient = {
    createCustomer: vi.fn(async (args) => { calls.push({ method: 'createCustomer', args }); return { id: 'cus_new' }; }),
    createCheckoutSession: vi.fn(async (args) => {
      calls.push({ method: 'createCheckoutSession', args });
      return { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' };
    }),
    createPortalSession: vi.fn(async (args) => {
      calls.push({ method: 'createPortalSession', args });
      return { id: 'bps_1', url: 'https://billing.stripe.com/p/session/bps_1' };
    }),
    getSubscription: vi.fn(async (id) => { calls.push({ method: 'getSubscription', args: id }); return subscription; }),
  };
  return { client, calls };
}

const LINKED = { id: 'user-1', email: 'viewer@example.com', isAnonymous: false };
const GUEST = { id: 'user-anon', email: null, isAnonymous: true };

const checkoutArgs = {
  priceId: 'price_premium_monthly',
  successUrl: 'https://skullygxng.github.io/GlockTV/?billing=return',
  cancelUrl: 'https://skullygxng.github.io/GlockTV/?billing=cancelled',
};

describe('webhook signature', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });

  it('accepts a correctly signed payload', async () => {
    const header = await signStripePayload({ rawBody: body, secret: SECRET, timestamp: Math.floor(NOW.getTime() / 1000) });
    expect(await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: NOW }))
      .toEqual({ ok: true });
  });

  it('rejects an unsigned request', async () => {
    expect(await verifyStripeSignature({ rawBody: body, signatureHeader: null, secret: SECRET, now: NOW }))
      .toEqual({ ok: false, reason: 'missing_header' });
    expect(await verifyStripeSignature({ rawBody: body, signatureHeader: '', secret: SECRET, now: NOW }))
      .toEqual({ ok: false, reason: 'missing_header' });
  });

  it('rejects a forged signature', async () => {
    const header = `t=${Math.floor(NOW.getTime() / 1000)},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: NOW }))
      .toEqual({ ok: false, reason: 'no_match' });
  });

  it('rejects a signature made with the wrong secret', async () => {
    const header = await signStripePayload({ rawBody: body, secret: 'whsec_someone_elses', timestamp: Math.floor(NOW.getTime() / 1000) });
    expect((await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: NOW })).ok).toBe(false);
  });

  it('rejects a valid signature over a different body', async () => {
    // The whole point of signing the raw bytes: tampering invalidates it.
    const header = await signStripePayload({ rawBody: body, secret: SECRET, timestamp: Math.floor(NOW.getTime() / 1000) });
    const tampered = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', extra: true });
    expect((await verifyStripeSignature({ rawBody: tampered, signatureHeader: header, secret: SECRET, now: NOW })).ok).toBe(false);
  });

  it('rejects a replayed capture from outside the tolerance window', async () => {
    const old = Math.floor(NOW.getTime() / 1000) - DEFAULT_TOLERANCE_SECONDS - 60;
    const header = await signStripePayload({ rawBody: body, secret: SECRET, timestamp: old });
    expect(await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: NOW }))
      .toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a malformed header, including an unknown scheme version', async () => {
    for (const header of ['garbage', 't=123', 'v1=abc', 't=abc,v1=abc', 'v0=abc,t=1']) {
      expect((await verifyStripeSignature({ rawBody: body, signatureHeader: header, secret: SECRET, now: NOW })).ok).toBe(false);
    }
  });
});

describe('checkout authority', () => {
  it('refuses an anonymous account', async () => {
    const { store } = makeStore();
    const { client, calls } = makeStripe();

    const result = await startCheckout({ user: GUEST, store, stripe: client, ...checkoutArgs });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(calls).toHaveLength(0);
  });

  it('lets a linked account start checkout and creates its customer once', async () => {
    const { store, customers, writes } = makeStore();
    const { client, calls } = makeStripe();

    const first = await startCheckout({ user: LINKED, store, stripe: client, ...checkoutArgs });
    expect(first).toMatchObject({ ok: true, url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(customers.get('user-1')).toBe('cus_new');

    const second = await startCheckout({ user: LINKED, store, stripe: client, ...checkoutArgs });
    expect(second.ok).toBe(true);

    // Second checkout reuses the mapping instead of creating another customer.
    expect(calls.filter((call) => call.method === 'createCustomer')).toHaveLength(1);
    expect(writes.filter((write) => write.startsWith('customer:'))).toHaveLength(1);
  });

  it('bills only the configured price, and for the authenticated user', async () => {
    const { store } = makeStore();
    const { client, calls } = makeStripe();

    await startCheckout({ user: LINKED, store, stripe: client, ...checkoutArgs });

    const session = calls.find((call) => call.method === 'createCheckoutSession')?.args as Record<string, unknown>;
    expect(session.priceId).toBe('price_premium_monthly');
    expect(session.supabaseUserId).toBe('user-1');
    expect(session.customerId).toBe('cus_new');
  });

  it('has no parameter through which a caller could name a user, customer, price or tier', () => {
    /*
     * The strongest statement available: the function's own signature. Every
     * trusted value is derived server-side, so there is no forged field to
     * ignore - the shape makes forgery unrepresentable.
     */
    const source = startCheckout.toString();
    expect(source).not.toMatch(/body\s*\.\s*(user_?[Ii]d|customer|price|tier)/);
    expect(startCheckout.length).toBe(1);
  });

  it('refuses when no price is configured rather than guessing one', async () => {
    const { store } = makeStore();
    const { client, calls } = makeStripe();

    const result = await startCheckout({ user: LINKED, store, stripe: client, ...checkoutArgs, priceId: '' });

    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(calls.filter((call) => call.method === 'createCheckoutSession')).toHaveLength(0);
  });
});

describe('billing portal authority', () => {
  it('opens the portal for the caller own customer', async () => {
    const { store } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_mine' });
    const { client, calls } = makeStripe();

    const result = await openBillingPortal({ user: LINKED, store, stripe: client, returnUrl: 'https://skullygxng.github.io/GlockTV/' });

    expect(result).toMatchObject({ ok: true, url: 'https://billing.stripe.com/p/session/bps_1' });
    expect((calls[0].args as { customerId: string }).customerId).toBe('cus_mine');
  });

  it('cannot be pointed at somebody else customer', async () => {
    const { store } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_mine' });
    await store.saveCustomer({ userId: 'user-2', providerCustomerId: 'cus_theirs' });
    const { client, calls } = makeStripe();

    await openBillingPortal({ user: LINKED, store, stripe: client, returnUrl: 'https://skullygxng.github.io/GlockTV/' });

    // Only the authenticated user's own mapping is ever consulted.
    expect((calls[0].args as { customerId: string }).customerId).toBe('cus_mine');
    expect(openBillingPortal.length).toBe(1);
  });

  it('says there is nothing to manage when the account has never paid', async () => {
    const { store } = makeStore();
    const { client, calls } = makeStripe();

    expect(await openBillingPortal({ user: LINKED, store, stripe: client, returnUrl: 'https://x/' }))
      .toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(0);
  });
});

function event(over: Partial<StripeEvent> = {}): StripeEvent {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    created: Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000),
    data: { object: stripeSubscription() as unknown as Record<string, unknown> },
    ...over,
  };
}

describe('webhook application', () => {
  it('grants Premium from a verified active subscription', async () => {
    const { store, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const { client } = makeStripe();

    const outcome = await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });

    expect(outcome).toMatchObject({ handled: true, userId: 'user-1', tier: 'premium' });
    expect(entitlements.get('user-1')).toEqual({ tier: 'premium', ads_enabled: false });
  });

  it('re-reads the subscription rather than trusting the event payload', async () => {
    const { store, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    /* Stripe's real answer is canceled; the event body claims active. */
    const { client, calls } = makeStripe(stripeSubscription({ status: 'canceled' }));

    const claimsActive = event({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', subscription: 'sub_1', status: 'active' } },
    });
    await applyStripeEvent({ event: claimsActive, store, stripe: client, now: NOW });

    expect(calls.some((call) => call.method === 'getSubscription')).toBe(true);
    expect(entitlements.get('user-1')).toEqual({ tier: 'free', ads_enabled: true });
  });

  it('downgrades to an explicit free row when the subscription ends', async () => {
    const { store, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const { client } = makeStripe(stripeSubscription({ status: 'canceled' }));

    await applyStripeEvent({ event: event({ type: 'customer.subscription.deleted' }), store, stripe: client, now: NOW });

    expect(entitlements.get('user-1')).toEqual({ tier: 'free', ads_enabled: true });
  });

  it('is idempotent when Stripe retries the same event', async () => {
    const { store, writes } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const { client } = makeStripe();

    const first = await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });
    const writesAfterFirst = writes.length;
    const replay = await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });

    expect(first.handled).toBe(true);
    expect(replay).toEqual({ handled: false, reason: 'replay' });
    expect(writes).toHaveLength(writesAfterFirst);
  });

  it('ignores a stale event that arrives after a newer one', async () => {
    const { store, entitlements, subscriptions } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });

    const newer = makeStripe(stripeSubscription({ status: 'active' }));
    await applyStripeEvent({
      event: event({ id: 'evt_new', created: Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000) }),
      store, stripe: newer.client, now: NOW,
    });
    expect(entitlements.get('user-1')?.tier).toBe('premium');

    /* An older cancellation, delivered late, must not revoke the newer state. */
    const older = makeStripe(stripeSubscription({ status: 'canceled' }));
    const outcome = await applyStripeEvent({
      event: event({ id: 'evt_old', type: 'customer.subscription.deleted', created: Math.floor(Date.parse('2026-09-01T11:00:00Z') / 1000) }),
      store, stripe: older.client, now: NOW,
    });

    expect(outcome).toEqual({ handled: false, reason: 'stale' });
    expect(entitlements.get('user-1')?.tier).toBe('premium');
    expect(subscriptions.get('user-1')?.status).toBe('active');
  });

  it('does not act on an event whose customer maps to no account', async () => {
    const { store, entitlements } = makeStore();
    const { client } = makeStripe(stripeSubscription({ customer: 'cus_unknown', metadata: undefined }));

    const outcome = await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });

    expect(outcome).toEqual({ handled: false, reason: 'unknown_customer' });
    expect(entitlements.size).toBe(0);
  });

  it('falls back to server-set metadata and records the mapping', async () => {
    const { store, customers, entitlements } = makeStore();
    const { client } = makeStripe(stripeSubscription({
      customer: 'cus_fresh',
      metadata: { supabase_user_id: 'user-7' },
    }));

    const outcome = await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });

    expect(outcome).toMatchObject({ handled: true, userId: 'user-7' });
    // Recorded, so later events do not depend on metadata at all.
    expect(customers.get('user-7')).toBe('cus_fresh');
    expect(entitlements.get('user-7')?.tier).toBe('premium');
  });

  it('records but does not act on an event type it does not handle', async () => {
    const { store, entitlements, events } = makeStore();
    const { client } = makeStripe();

    const outcome = await applyStripeEvent({
      event: event({ id: 'evt_other', type: 'customer.updated' }),
      store, stripe: client, now: NOW,
    });

    expect(outcome).toEqual({ handled: false, reason: 'ignored_event' });
    expect(entitlements.size).toBe(0);
    // Recorded anyway, so a retry of it is cheap.
    expect(events.has('evt_other')).toBe(true);
  });

  it('applies the cancel-at-period-end window through the webhook path', async () => {
    const { store, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const { client } = makeStripe(stripeSubscription({
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: Math.floor(Date.parse('2026-09-15T00:00:00Z') / 1000),
    }));

    await applyStripeEvent({ event: event(), store, stripe: client, now: NOW });
    expect(entitlements.get('user-1')?.tier).toBe('premium');

    /* Same subscription, read after the period has run out. */
    const { store: later, entitlements: laterEntitlements } = makeStore();
    await later.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    await applyStripeEvent({
      event: event({ id: 'evt_2' }), store: later, stripe: client,
      now: new Date('2026-09-20T00:00:00Z'),
    });
    expect(laterEntitlements.get('user-1')?.tier).toBe('free');
  });
});
