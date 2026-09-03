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

/*
 * An in-memory BillingStore that behaves like the real tables - including the
 * property this delta is about.
 *
 * applyProviderState awaits first (standing in for the round trip two
 * concurrent Edge Function invocations both make) and then runs its
 * claim-compare-write body with no await inside it. That synchronous body is
 * the model of the Postgres row lock: whatever order two callers arrive in,
 * one completes its comparison and write before the other begins. A fake that
 * awaited mid-body would be modelling the bug rather than the database.
 */
function makeStore({ latency = 0 }: { latency?: number } = {}) {
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

    async applyProviderState({ userId, subscription, entitlement, event }) {
      await new Promise((resolve) => setTimeout(resolve, latency));

      // --- atomic from here; no await until it returns ---
      if (events.has(event.providerEventId)) return 'replay';
      events.add(event.providerEventId);

      const stored = subscriptions.get(userId);
      const incoming = subscription.providerUpdatedAt ? Date.parse(subscription.providerUpdatedAt) : NaN;
      const committed = stored?.providerUpdatedAt ? Date.parse(stored.providerUpdatedAt) : NaN;
      if (Number.isFinite(committed) && (!Number.isFinite(incoming) || incoming < committed)) {
        return 'stale';
      }

      writes.push(`subscription:${userId}:${subscription.status}`);
      subscriptions.set(userId, {
        providerUpdatedAt: subscription.providerUpdatedAt,
        status: subscription.status,
      });
      writes.push(`entitlement:${userId}:${entitlement.tier}`);
      entitlements.set(userId, entitlement);
      return 'applied';
      // --- atomic to here ---
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

describe('concurrent webhook delivery', () => {
  /* Stripe delivers in parallel and retries; two invocations can be in flight
     at once, so ordering cannot be decided by a read followed by a write. */
  function subscriptionEvent(id: string, status: string, at: string) {
    return {
      event: event({ id, type: 'customer.subscription.updated', created: Math.floor(Date.parse(at) / 1000) }),
      stripe: makeStripe(stripeSubscription({ status })).client,
    };
  }

  it('cannot leave older state committed, whichever order the two finish in', async () => {
    for (const olderFirst of [true, false]) {
      const { store, entitlements, subscriptions } = makeStore({ latency: 5 });
      await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });

      const newer = subscriptionEvent('evt_new', 'active', '2026-09-01T12:00:00Z');
      const older = subscriptionEvent('evt_old', 'canceled', '2026-09-01T11:00:00Z');
      const [first, second] = olderFirst ? [older, newer] : [newer, older];

      /* Both started before either completes - the interleaving the previous
         read-compare-write could not survive. */
      await Promise.all([
        applyStripeEvent({ event: first.event, store, stripe: first.stripe, now: NOW }),
        applyStripeEvent({ event: second.event, store, stripe: second.stripe, now: NOW }),
      ]);

      expect(subscriptions.get('user-1')?.status, `olderFirst=${olderFirst}`).toBe('active');
      expect(entitlements.get('user-1')?.tier, `olderFirst=${olderFirst}`).toBe('premium');
    }
  });

  it('cannot be raced into an older state by many interleavings', async () => {
    /* Eight events, applied concurrently in a shuffled order. Whatever the
       scheduler does, the newest must win. */
    const { store, subscriptions, entitlements } = makeStore({ latency: 2 });
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });

    const hours = [9, 13, 10, 16, 11, 14, 12, 15];
    await Promise.all(hours.map((hour, index) => {
      const at = `2026-09-01T${String(hour).padStart(2, '0')}:00:00Z`;
      const status = hour === 16 ? 'active' : 'canceled';
      const { event: e, stripe } = subscriptionEvent(`evt_${index}`, status, at);
      return applyStripeEvent({ event: e, store, stripe, now: NOW });
    }));

    // 16:00 is the latest, and it is the active one.
    expect(subscriptions.get('user-1')?.providerUpdatedAt).toBe('2026-09-01T16:00:00.000Z');
    expect(subscriptions.get('user-1')?.status).toBe('active');
    expect(entitlements.get('user-1')?.tier).toBe('premium');
  });

  it('stays idempotent when the same event is delivered twice at once', async () => {
    const { store, writes } = makeStore({ latency: 5 });
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const a = subscriptionEvent('evt_same', 'active', '2026-09-01T12:00:00Z');
    const b = subscriptionEvent('evt_same', 'active', '2026-09-01T12:00:00Z');

    const outcomes = await Promise.all([
      applyStripeEvent({ event: a.event, store, stripe: a.stripe, now: NOW }),
      applyStripeEvent({ event: b.event, store, stripe: b.stripe, now: NOW }),
    ]);

    expect(outcomes.filter((outcome) => outcome.handled)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.handled && outcome.reason === 'replay')).toHaveLength(1);
    // Exactly one subscription write and one entitlement write.
    expect(writes.filter((write) => write.startsWith('subscription:'))).toHaveLength(1);
    expect(writes.filter((write) => write.startsWith('entitlement:'))).toHaveLength(1);
  });

  it('leaves ordering and replay to the database rather than deciding them itself', () => {
    /*
     * The regression this guards: a read of the stored timestamp, compared in
     * TypeScript, followed by a separate write. Two invocations can interleave
     * between those steps no matter how the comparison is written.
     */
    const source = applyStripeEvent.toString();
    expect(source).toContain('applyProviderState');
    /* store.getSubscription is gone; stripe.getSubscription stays - re-reading
       the authoritative subscription from Stripe is the point. */
    expect(source).not.toMatch(/store\.getSubscription/);
    expect(source).toMatch(/stripe\.getSubscription/);
    expect(source).not.toMatch(/hasProcessedEvent/);
    expect(source).not.toMatch(/isNewerProviderState/);
  });
});

describe('an event that cannot prove it is newer', () => {
  /*
   * Stripe events normally carry a created timestamp, but a malformed or
   * hand-crafted payload need not. An event with no usable timestamp has no
   * claim to be newer than what is committed, so it must not overwrite it -
   * the SQL briefly allowed exactly that.
   */
  function untimestamped(id: string, status: string) {
    return {
      // No `created`, so nothing downstream can derive a provider timestamp.
      event: { id, type: 'customer.subscription.updated', data: { object: stripeSubscription({ status }) as unknown as Record<string, unknown> } } as StripeEvent,
      stripe: makeStripe(stripeSubscription({ status })).client,
    };
  }

  async function commitTimestamped(store: BillingStore, status: string, at: string) {
    const stripe = makeStripe(stripeSubscription({ status })).client;
    return applyStripeEvent({
      event: event({ id: `evt_${at}`, created: Math.floor(Date.parse(at) / 1000) }),
      store, stripe, now: NOW,
    });
  }

  it('cannot overwrite committed timestamped state', async () => {
    const { store, subscriptions, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    await commitTimestamped(store, 'active', '2026-09-01T12:00:00Z');
    expect(entitlements.get('user-1')?.tier).toBe('premium');

    const forged = untimestamped('evt_no_ts', 'canceled');
    const outcome = await applyStripeEvent({ event: forged.event, store, stripe: forged.stripe, now: NOW });

    expect(outcome).toEqual({ handled: false, reason: 'stale' });
    expect(subscriptions.get('user-1')?.status).toBe('active');
    expect(entitlements.get('user-1')?.tier).toBe('premium');
  });

  it('cannot overwrite committed state even when it would upgrade', async () => {
    /* Fail closed in both directions: the rule is about trustworthiness, not
       about which way the change happens to go. */
    const { store, entitlements } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    await commitTimestamped(store, 'canceled', '2026-09-01T12:00:00Z');
    expect(entitlements.get('user-1')?.tier).toBe('free');

    const forged = untimestamped('evt_no_ts_up', 'active');
    const outcome = await applyStripeEvent({ event: forged.event, store, stripe: forged.stripe, now: NOW });

    expect(outcome).toEqual({ handled: false, reason: 'stale' });
    expect(entitlements.get('user-1')?.tier).toBe('free');
  });

  it('may still establish the first state when nothing is committed', async () => {
    /* A null on the committed side means nothing is established yet, which is
       a different thing from an incoming event that cannot date itself. */
    const { store, entitlements, subscriptions } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });

    const first = untimestamped('evt_first', 'active');
    const outcome = await applyStripeEvent({ event: first.event, store, stripe: first.stripe, now: NOW });

    expect(outcome).toMatchObject({ handled: true, tier: 'premium' });
    expect(subscriptions.get('user-1')?.providerUpdatedAt).toBeNull();
    expect(entitlements.get('user-1')?.tier).toBe('premium');
  });

  it('lets a properly timestamped event take over from an untimestamped first state', async () => {
    const { store, entitlements, subscriptions } = makeStore();
    await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
    const first = untimestamped('evt_first2', 'active');
    await applyStripeEvent({ event: first.event, store, stripe: first.stripe, now: NOW });

    await commitTimestamped(store, 'canceled', '2026-09-01T12:00:00Z');

    expect(subscriptions.get('user-1')?.status).toBe('canceled');
    expect(entitlements.get('user-1')?.tier).toBe('free');
  });

  it('cannot win a race against a timestamped event, in either arrival order', async () => {
    for (const forgedFirst of [true, false]) {
      const { store, entitlements, subscriptions } = makeStore({ latency: 5 });
      await store.saveCustomer({ userId: 'user-1', providerCustomerId: 'cus_1' });
      await commitTimestamped(store, 'active', '2026-09-01T10:00:00Z');

      const forged = untimestamped('evt_race_null', 'canceled');
      const real = {
        event: event({ id: 'evt_race_real', created: Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000) }),
        stripe: makeStripe(stripeSubscription({ status: 'active' })).client,
      };
      const [a, b] = forgedFirst ? [forged, real] : [real, forged];

      await Promise.all([
        applyStripeEvent({ event: a.event, store, stripe: a.stripe, now: NOW }),
        applyStripeEvent({ event: b.event, store, stripe: b.stripe, now: NOW }),
      ]);

      expect(subscriptions.get('user-1')?.status, `forgedFirst=${forgedFirst}`).toBe('active');
      expect(entitlements.get('user-1')?.tier, `forgedFirst=${forgedFirst}`).toBe('premium');
    }
  });
});
