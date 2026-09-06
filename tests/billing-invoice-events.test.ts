import { describe, expect, it, vi } from 'vitest';
import { applyStripeEvent } from '../supabase/functions/_shared/billing';
import type { BillingStore } from '../supabase/functions/_shared/billingStore';
import type { StripeClient, StripeSubscriptionObject } from '../supabase/functions/_shared/stripe';

/*
 * Invoice events, which had no behavioural coverage at all until now.
 *
 * Two of the six subscribed event types are invoice events, and every renewal
 * arrives as one. The gap let a shape assumption survive: an Invoice has an id
 * and a status, so a fallback meant for subscriptions matched it, and the
 * invoice id was sent to Stripe as a subscription id. Stripe answered 404, the
 * handler threw, the webhook returned 500, and Stripe retried a delivery that
 * could never succeed.
 */

const NOW = new Date('2026-09-06T00:00:00Z');

function subscriptionObject(over: Partial<StripeSubscriptionObject> = {}): StripeSubscriptionObject {
  return {
    id: 'sub_live',
    object: 'subscription',
    customer: 'cus_live',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000),
    items: { data: [{ price: { id: 'price_premium_monthly' } }] },
    ...over,
  };
}

/* Only sub_* exists, exactly as Stripe behaves: asking for an in_* id 404s. */
function harness() {
  const asked: string[] = [];
  const marked: Array<{ providerEventId: string; eventType: string }> = [];
  const applied: Array<{ userId: string; eventType: string }> = [];

  const stripe = {
    createCustomer: vi.fn(async () => ({ id: 'cus_new' })),
    createCheckoutSession: vi.fn(async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' })),
    createPortalSession: vi.fn(async () => ({ id: 'ps_1', url: 'https://billing.stripe.com/p/session/ps_1' })),
    getSubscription: vi.fn(async (id: string) => {
      asked.push(id);
      if (!id.startsWith('sub_')) throw new Error(`No such subscription: '${id}'`);
      return subscriptionObject({ id });
    }),
  } satisfies StripeClient;

  const store = {
    getCustomerByUser: async () => null,
    getUserByCustomer: async () => ({ userId: 'user-1' }),
    saveCustomer: async () => {},
    applyProviderState: async ({ userId, event }) => { applied.push({ userId, eventType: event.eventType }); return 'applied' as const; },
    markEventProcessed: async ({ providerEventId, eventType }) => { marked.push({ providerEventId, eventType }); },
  } satisfies BillingStore;

  return { stripe, store, asked, marked, applied };
}

const INVOICE_EVENTS = ['invoice.payment_succeeded', 'invoice.payment_failed'] as const;

describe.each(INVOICE_EVENTS)('%s', (eventType) => {
  it('resolves the real subscription from the Basil parent shape', async () => {
    const h = harness();
    const outcome = await applyStripeEvent({
      event: {
        id: `evt_basil_${eventType}`,
        type: eventType,
        created: Math.floor(NOW.getTime() / 1000),
        data: {
          object: {
            id: 'in_basil', object: 'invoice', status: 'paid',
            /* 2025-03-31.basil: `subscription` was removed from Invoice and the
               reference moved here. */
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_live' } },
          },
        },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });

    expect(h.asked).toEqual(['sub_live']);
    expect(outcome).toMatchObject({ handled: true, reason: 'applied', userId: 'user-1' });
  });

  it('still resolves the pre-Basil top-level subscription field', async () => {
    const h = harness();
    const outcome = await applyStripeEvent({
      event: {
        id: `evt_legacy_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'in_legacy', object: 'invoice', status: 'paid', subscription: 'sub_live' } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });

    expect(h.asked).toEqual(['sub_live']);
    expect(outcome).toMatchObject({ handled: true, reason: 'applied' });
  });

  it('accepts an expanded subscription reference', async () => {
    const h = harness();
    await applyStripeEvent({
      event: {
        id: `evt_expanded_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'in_exp', object: 'invoice', status: 'paid', subscription: { id: 'sub_live' } } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual(['sub_live']);
  });

  it('never sends the invoice id to Stripe when no reference is present', async () => {
    const h = harness();
    const outcome = await applyStripeEvent({
      event: {
        id: `evt_bare_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'in_bare', object: 'invoice', status: 'paid' } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });

    /* The regression in one line: this used to be ['in_bare']. */
    expect(h.asked).toEqual([]);
    expect(h.stripe.getSubscription).not.toHaveBeenCalled();
    /* Recorded and acknowledged, so Stripe stops retrying: HTTP-200 semantics. */
    expect(outcome).toEqual({ handled: false, reason: 'no_subscription' });
    expect(h.marked).toEqual([{ providerEventId: `evt_bare_${eventType}`, eventType }]);
  });

  it('does not throw on an unresolvable invoice, so the webhook cannot 500', async () => {
    const h = harness();
    await expect(applyStripeEvent({
      event: {
        id: `evt_nothrow_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'in_nothrow', object: 'invoice', status: 'open' } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    })).resolves.toBeDefined();
  });

  it('ignores a parent that is not subscription_details', async () => {
    const h = harness();
    const outcome = await applyStripeEvent({
      event: {
        id: `evt_other_parent_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
        data: {
          object: {
            id: 'in_qp', object: 'invoice', status: 'paid',
            /* parent is a tagged union; other arms reference other things. */
            parent: { type: 'quote_details', quote_details: { quote: 'qt_1' }, subscription_details: { subscription: 'sub_live' } },
          },
        },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual([]);
    expect(outcome).toEqual({ handled: false, reason: 'no_subscription' });
  });
});

describe('direct subscription events keep working', () => {
  it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'])(
    '%s resolves the subscription from the object itself',
    async (eventType) => {
      const h = harness();
      await applyStripeEvent({
        event: {
          id: `evt_${eventType}`, type: eventType, created: Math.floor(NOW.getTime() / 1000),
          data: { object: subscriptionObject() as unknown as Record<string, unknown> },
        },
        stripe: h.stripe, store: h.store, now: NOW,
      });
      expect(h.asked).toEqual(['sub_live']);
    },
  );

  it('still resolves a subscription payload that omits the object discriminator', async () => {
    const h = harness();
    const { object: _discriminator, ...withoutTag } = subscriptionObject() as Record<string, unknown>;
    await applyStripeEvent({
      event: {
        id: 'evt_no_tag', type: 'customer.subscription.updated', created: Math.floor(NOW.getTime() / 1000),
        data: { object: withoutTag },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual(['sub_live']);
  });

  it('checkout.session.completed still references its subscription', async () => {
    const h = harness();
    await applyStripeEvent({
      event: {
        id: 'evt_checkout', type: 'checkout.session.completed', created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'cs_1', object: 'checkout.session', status: 'complete', subscription: 'sub_live' } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual(['sub_live']);
  });
});

describe('an invoice is never mistaken for a subscription', () => {
  it('does not treat id + status alone as a subscription', async () => {
    const h = harness();
    await applyStripeEvent({
      event: {
        id: 'evt_lookalike', type: 'invoice.payment_succeeded', created: Math.floor(NOW.getTime() / 1000),
        /* No `object` tag, no items: the exact shape the old fallback accepted. */
        data: { object: { id: 'in_lookalike', status: 'paid' } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual([]);
  });

  it('an invoice carrying `lines` is not confused with a subscription carrying `items`', async () => {
    const h = harness();
    await applyStripeEvent({
      event: {
        id: 'evt_lines', type: 'invoice.payment_succeeded', created: Math.floor(NOW.getTime() / 1000),
        data: { object: { id: 'in_lines', object: 'invoice', status: 'paid', lines: { data: [{ id: 'il_1' }] } } },
      },
      stripe: h.stripe, store: h.store, now: NOW,
    });
    expect(h.asked).toEqual([]);
  });
});
