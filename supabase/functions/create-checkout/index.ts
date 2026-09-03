import { startCheckout } from '../_shared/billing.ts';
import { allowedOrigin, corsHeaders } from '../_shared/cors.ts';
import { createStripeClient } from '../_shared/stripe.ts';
import { authenticateRequest, createSupabaseBillingStore } from '../_shared/supabaseStore.ts';

/*
 * Starts a Stripe Checkout session for the authenticated caller.
 *
 * Thin on purpose: read secrets, identify the caller, hand off. The decisions
 * worth auditing - anonymous accounts refused, the price fixed server-side,
 * the customer taken from the caller's own mapping - live in _shared/billing
 * where they are unit-tested.
 */
Deno.serve(async (request: Request) => {
  const origin = allowedOrigin(request.headers.get('origin'), [Deno.env.get('GLOCKTV_SITE_ORIGIN') ?? '']);
  const cors = corsHeaders(origin);

  if (request.method === 'OPTIONS') {
    return origin
      ? new Response(null, { status: 204, headers: cors })
      : new Response(null, { status: 403 });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  if (!origin) return new Response('Origin not allowed', { status: 403 });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const priceId = Deno.env.get('STRIPE_PRICE_PREMIUM_MONTHLY') ?? '';

  if (!supabaseUrl || !serviceRoleKey || !stripeKey || !priceId) {
    return json({ error: 'Premium is not configured yet.' }, 500, cors);
  }

  const user = await authenticateRequest({
    supabaseUrl,
    anonOrServiceKey: serviceRoleKey,
    authorizationHeader: request.headers.get('authorization'),
  });
  if (!user) return json({ error: 'Sign in to subscribe.' }, 401, cors);

  const result = await startCheckout({
    user,
    store: createSupabaseBillingStore({ supabaseUrl, serviceRoleKey }),
    stripe: createStripeClient(stripeKey),
    priceId,
    /*
     * Cosmetic landing pages. The success URL grants nothing - the account
     * panel re-reads entitlements from the server when it sees this marker,
     * and stays free until a verified webhook says otherwise.
     */
    successUrl: `${origin}/GlockTV/?billing=return`,
    cancelUrl: `${origin}/GlockTV/?billing=cancelled`,
  }).catch((reason: unknown) => ({
    ok: false as const,
    status: 502,
    error: reason instanceof Error ? reason.message : 'Checkout could not be started.',
  }));

  return result.ok ? json({ url: result.url }, 200, cors) : json({ error: result.error }, result.status, cors);
});

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
