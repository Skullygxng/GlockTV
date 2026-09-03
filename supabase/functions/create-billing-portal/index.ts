import { openBillingPortal } from '../_shared/billing.ts';
import { allowedOrigin, corsHeaders } from '../_shared/cors.ts';
import { createStripeClient } from '../_shared/stripe.ts';
import { authenticateRequest, createSupabaseBillingStore } from '../_shared/supabaseStore.ts';

/*
 * Opens the Stripe billing portal for the authenticated caller.
 *
 * The customer is looked up from the caller's own mapping, so naming somebody
 * else's customer in the request body achieves nothing.
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

  if (!supabaseUrl || !serviceRoleKey || !stripeKey) {
    return json({ error: 'Membership management is not configured yet.' }, 500, cors);
  }

  const user = await authenticateRequest({
    supabaseUrl,
    anonOrServiceKey: serviceRoleKey,
    authorizationHeader: request.headers.get('authorization'),
  });
  if (!user) return json({ error: 'Sign in to manage your membership.' }, 401, cors);

  const result = await openBillingPortal({
    user,
    store: createSupabaseBillingStore({ supabaseUrl, serviceRoleKey }),
    stripe: createStripeClient(stripeKey),
    returnUrl: `${origin}/GlockTV/?billing=portal-return`,
  }).catch((reason: unknown) => ({
    ok: false as const,
    status: 502,
    error: reason instanceof Error ? reason.message : 'The billing portal could not be opened.',
  }));

  return result.ok ? json({ url: result.url }, 200, cors) : json({ error: result.error }, result.status, cors);
});

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
