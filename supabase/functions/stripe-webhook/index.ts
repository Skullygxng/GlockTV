import { applyStripeEvent, type StripeEvent } from '../_shared/billing.ts';
import { verifyStripeSignature } from '../_shared/stripeSignature.ts';
import { createStripeClient } from '../_shared/stripe.ts';
import { createSupabaseBillingStore } from '../_shared/supabaseStore.ts';

/*
 * The only thing that can grant Premium.
 *
 * No browser calls this and no user JWT is accepted; the proof of authority is
 * Stripe's signature over the exact bytes received. The body is read as text
 * and never re-serialized, because re-encoding JSON changes the bytes and
 * invalidates the signature.
 */
Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  if (!webhookSecret || !stripeKey || !supabaseUrl || !serviceRoleKey) {
    return new Response('Billing is not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const verification = await verifyStripeSignature({
    rawBody,
    signatureHeader: request.headers.get('stripe-signature'),
    secret: webhookSecret,
  });
  if (!verification.ok) {
    /* The reason is logged, not returned: telling a caller which part of their
       forgery failed helps them iterate on it. */
    console.warn('Rejected Stripe webhook', verification.reason);
    return new Response('Invalid signature', { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return new Response('Malformed event', { status: 400 });
  }
  if (!event?.id || !event.type) return new Response('Malformed event', { status: 400 });

  try {
    const outcome = await applyStripeEvent({
      event,
      store: createSupabaseBillingStore({ supabaseUrl, serviceRoleKey }),
      stripe: createStripeClient(stripeKey),
    });
    return new Response(JSON.stringify(outcome), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (reason) {
    /* A 500 makes Stripe retry, which is what we want for a transient failure:
       the event is only recorded as processed once it actually applied. */
    console.error('Stripe webhook failed', reason instanceof Error ? reason.message : reason);
    return new Response('Webhook handling failed', { status: 500 });
  }
});
