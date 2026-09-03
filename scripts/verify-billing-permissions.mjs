#!/usr/bin/env node
// Billing permission smoke test, run against a real Supabase project.
//
// apply_billing_provider_state writes account_entitlements directly, so who may
// execute it is the whole security boundary: the webhook must be able to, and a
// browser must not. That permission lives in the database, not in this
// repository, and reading the migration proves nothing about what the project
// actually did with it - a GRANT can be missing, over-broad, or undone by hand.
//
// So this asks the real project three questions:
//
//   1. service-role key                        -> must SUCCEED
//   2. publishable key, signed out             -> must be REFUSED
//   3. publishable key, signed in as an ordinary user -> must be REFUSED
//
// A failure of 1 means every webhook silently 500s and nobody can become
// Premium. A success of 2 or 3 means anyone can set their own tier, which is
// the P1 this test exists to catch.
//
// Usage (nothing is read from a file, and nothing is written to one):
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=<service role key> \
//   SUPABASE_PUBLISHABLE_KEY=<publishable key> \
//   node scripts/verify-billing-permissions.mjs
//
// Run it against the TEST-mode project. It writes throwaway rows under an
// obvious smoke-test namespace and removes them again, and it never grants
// premium to anything: the tier it applies is 'free'.

import { createClient } from '@supabase/supabase-js';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? '';

const missing = [
  ['SUPABASE_URL', url],
  ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
  ['SUPABASE_PUBLISHABLE_KEY', publishableKey],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length) {
  console.error(`Missing required environment: ${missing.join(', ')}`);
  console.error('This test needs a real project. It cannot be simulated.');
  process.exit(2);
}

if (serviceRoleKey === publishableKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY are the same value.');
  console.error('The test would compare a role against itself and prove nothing.');
  process.exit(2);
}

const RPC = `${url}/rest/v1/rpc/apply_billing_provider_state`;
const namespace = `smoke_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/*
 * The same payload for all three callers, so the only variable across the
 * three questions is which key presents it. tier is 'free' throughout: proving
 * the function executes does not require handing anybody Premium.
 */
function payload(userId) {
  return {
    p_user_id: userId,
    p_provider: 'stripe',
    p_subscription_id: `sub_${namespace}`,
    p_customer_id: `cus_${namespace}`,
    p_status: 'canceled',
    p_price_id: `price_${namespace}`,
    p_current_period_end: new Date(Date.now() - 86_400_000).toISOString(),
    p_cancel_at_period_end: false,
    p_provider_updated_at: new Date().toISOString(),
    p_tier: 'free',
    p_ads_enabled: true,
    p_event_id: `evt_${namespace}`,
    p_event_type: 'customer.subscription.deleted',
    p_event_created_at: new Date().toISOString(),
  };
}

async function callRpc(apikey, accessToken, body) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: {
      apikey,
      authorization: `Bearer ${accessToken ?? apikey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

/*
 * A real auth.uid() to key the write to. account_entitlements references
 * auth.users, so a made-up uuid would fail on the foreign key and the run
 * would report a permission problem that is really a missing user.
 *
 * This same session then answers question 3: it is an ordinary account holding
 * an ordinary user token, exactly what a browser has.
 */
async function createOrdinaryUser() {
  const client = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user || !data.session) {
    throw new Error(
      'Could not create an anonymous test user'
      + `${error ? `: ${error.message}` : ''}. Enable anonymous sign-ins on the `
      + 'project, or the signed-in half of this test cannot run.',
    );
  }
  return { userId: data.user.id, accessToken: data.session.access_token };
}

/* A refusal is any non-2xx. We report the code so an unexpected one is visible
   rather than being quietly counted as a pass. */
function refused(result) {
  return result.status < 200 || result.status >= 300;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
}

async function cleanup(userId) {
  const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` };
  const deletes = [
    `${url}/rest/v1/billing_webhook_events?provider_event_id=eq.evt_${namespace}`,
    `${url}/rest/v1/billing_subscriptions?user_id=eq.${userId}`,
    `${url}/rest/v1/account_entitlements?user_id=eq.${userId}`,
  ];
  for (const target of deletes) {
    try {
      await fetch(target, { method: 'DELETE', headers });
    } catch {
      /* Cleanup is courtesy. A leftover smoke_ row is harmless and named. */
    }
  }
}

const { userId, accessToken } = await createOrdinaryUser();
console.log(`Test user ${userId}\nNamespace ${namespace}\n`);

try {
  const asService = await callRpc(serviceRoleKey, serviceRoleKey, payload(userId));
  record(
    'service-role can execute apply_billing_provider_state',
    !refused(asService) && asService.body.includes('applied'),
    `HTTP ${asService.status} ${asService.body.slice(0, 200)}`,
  );

  /*
   * Signed out means the publishable key is the whole credential - the anon
   * role. A second event id is not needed: if the call is refused it never
   * reaches the claim, and if it is NOT refused that is the finding regardless
   * of what the function then returned.
   */
  const asAnon = await callRpc(publishableKey, null, payload(userId));
  record(
    'publishable key signed out is refused',
    refused(asAnon),
    `HTTP ${asAnon.status} ${asAnon.body.slice(0, 200)}`,
  );

  const asUser = await callRpc(publishableKey, accessToken, payload(userId));
  record(
    'publishable key signed in as an ordinary user is refused',
    refused(asUser),
    `HTTP ${asUser.status} ${asUser.body.slice(0, 200)}`,
  );
} finally {
  await cleanup(userId);
}

const failed = results.filter((result) => !result.ok);
console.log();
if (failed.length) {
  console.error(`${failed.length} of ${results.length} checks failed. Billing is NOT safe to activate.`);
  process.exit(1);
}
console.log(`All ${results.length} checks passed.`);
