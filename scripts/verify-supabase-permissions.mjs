#!/usr/bin/env node
// Real-project verification for GlockTV's security-critical database boundaries.
//
// Everything that stops one account reading another's watch history, stops a
// customer answering their own ticket as staff, and stops a browser granting
// itself Premium lives in PostgreSQL - in a grant, a policy, a trigger. The
// test suite reads those migrations and can prove a rule was *written*. It
// cannot prove what a project did with it: a grant can be missing, over-broad,
// or changed by hand later, and every source-level assertion would still pass.
//
// So this asks a real project. Each check has a wrong answer that is a
// privilege escalation, and the run exits non-zero if any of them comes back.
//
// Usage - nothing is read from a file and nothing is written to one:
//
//   export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY
//   node scripts/verify-supabase-permissions.mjs               # dry run
//   node scripts/verify-supabase-permissions.mjs --execute     # for real
//   node scripts/verify-supabase-permissions.mjs --execute --only billing
//
// Run it against the TEST-mode project. It creates its own throwaway users,
// writes only rows belonging to them, and deletes the users in a finally -
// which cascades every row this run created. It never grants Premium: the
// billing section applies the free tier.

import { createClient } from '@supabase/supabase-js';
import {
  billingChecks,
  caller,
  supportChecks,
  watchProgressChecks,
} from './lib/permission-checks.mjs';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const SECTIONS = ['billing', 'progress', 'support'];

if (only && !SECTIONS.includes(only)) {
  console.error(`--only must be one of: ${SECTIONS.join(', ')}`);
  process.exit(2);
}

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY
  ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  ?? '';

/*
 * Refuse ambiguity rather than guessing. A missing variable, or the same value
 * given for two different roles, would produce a run that compares a role
 * against itself and reports a clean bill of health.
 */
const missing = [
  ['SUPABASE_URL', url],
  ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
  ['SUPABASE_PUBLISHABLE_KEY', publishableKey],
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length) {
  console.error(`Missing required environment: ${missing.join(', ')}`);
  console.error('This verifier needs a real project. It cannot be simulated.');
  process.exit(2);
}
if (serviceRoleKey === publishableKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY are the same value.');
  console.error('The run would compare a role against itself and prove nothing.');
  process.exit(2);
}
if (!/^https:\/\//.test(url)) {
  console.error('SUPABASE_URL must be an https project URL.');
  process.exit(2);
}

const namespace = `verify_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

if (!execute) {
  /*
   * Safe by default. A run that mutates a database should be asked for, not
   * arrived at, so the default says exactly what it would do and does none of
   * it - and still confirms the credentials resolve and the project answers.
   */
  console.log(`Dry run. Nothing will be created, written or deleted.\n`);
  console.log(`Project   ${url}`);
  console.log(`Sections  ${(only ? [only] : SECTIONS).join(', ')}`);
  console.log(`Namespace ${namespace}\n`);
  console.log('It would:');
  console.log('  - create three throwaway auth users (customer A, customer B, staff)');
  console.log('  - add the staff user to staff_members with the service role');
  console.log('  - sign in anonymously, if the project allows it');
  console.log('  - write only rows owned by those users, tier free throughout');
  console.log('  - delete all three users in a finally, cascading every row\n');

  const probe = await fetch(`${url}/rest/v1/`, { headers: { apikey: publishableKey } }).catch(() => null);
  if (!probe) {
    console.error('Project did not answer. Check SUPABASE_URL and network access.');
    process.exit(2);
  }
  console.log(`Project answered: HTTP ${probe.status}`);
  console.log('\nRe-run with --execute to verify for real.');
  process.exit(0);
}

/* ------------------------------------------------------------------ plumbing */

const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function rest(who, method, path, payload, extraHeaders = {}) {
  const headers = {
    apikey: who.apikey,
    authorization: `Bearer ${who.accessToken}`,
    'content-type': 'application/json',
    ...extraHeaders,
  };
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { response, body: await response.text() };
}

async function rpc(who, payload) {
  return rest(who, 'POST', 'rpc/apply_billing_provider_state', payload);
}

/* A confirmed, non-anonymous account. Password sign-in gives a JWT whose
   is_anonymous claim is false, which is what the progress policies require. */
async function createProtectedUser(tag) {
  const email = `${namespace}_${tag}@glocktv-verify.invalid`;
  const password = `${namespace}_${Math.random().toString(36).slice(2)}Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Could not create ${tag}: ${error?.message ?? 'no user'}`);

  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !session.session) throw new Error(`Could not sign in ${tag}: ${signInError?.message}`);

  return { id: data.user.id, token: session.session.access_token };
}

async function createAnonymousUser() {
  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.session) return null;
  return { id: data.user.id, token: data.session.access_token };
}

const results = [];
function record(section, check, outcome) {
  results.push({ section, ...check, ...outcome });
  console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  [${section}] ${check.name}\n      ${outcome.detail}`);
}

/* ---------------------------------------------------------------------- run */

const created = [];
let anonymousUser = null;

try {
  const userA = await createProtectedUser('a');
  const userB = await createProtectedUser('b');
  const staffUser = await createProtectedUser('staff');
  created.push(userA.id, userB.id, staffUser.id);

  /* Staff membership is granted out of band by a trusted caller - the same
     path an operator uses, and the only one there is. */
  const { error: staffError } = await admin.from('staff_members').insert({ user_id: staffUser.id, role: 'agent' });
  if (staffError) throw new Error(`Could not seed staff fixture: ${staffError.message}`);

  anonymousUser = await createAnonymousUser();
  if (!anonymousUser) {
    console.log('NOTE  anonymous sign-ins are disabled on this project; the anonymous check will fail rather than be skipped.\n');
  }

  const service = caller('service-role', serviceRoleKey, serviceRoleKey);
  const anon = caller('anon', publishableKey, publishableKey);
  const callerA = caller('customer A', publishableKey, userA.token);
  const callerB = caller('customer B', publishableKey, userB.token);
  const callerStaff = caller('staff', publishableKey, staffUser.token);
  const callerAnonUser = anonymousUser ? caller('anonymous user', publishableKey, anonymousUser.token) : null;

  const payloadFor = () => ({
    p_user_id: userA.id,
    p_provider: 'stripe',
    p_subscription_id: `sub_${namespace}`,
    p_customer_id: `cus_${namespace}`,
    p_status: 'canceled',
    p_price_id: `price_${namespace}`,
    p_current_period_end: new Date(Date.now() - 86_400_000).toISOString(),
    p_cancel_at_period_end: false,
    p_provider_updated_at: new Date().toISOString(),
    /* Free throughout. Proving the write path does not require selling
       anybody a membership. */
    p_tier: 'free',
    p_ads_enabled: true,
    p_event_id: `evt_${namespace}`,
    p_event_type: 'customer.subscription.deleted',
    p_event_created_at: new Date().toISOString(),
  });

  const progressRow = ({ mediaId, forUser }) => ({
    user_id: forUser === 'A' ? userA.id : forUser === 'anon' ? anonymousUser?.id : userA.id,
    media_type: 'movie',
    media_id: mediaId,
    season_number: 0,
    episode_number: 0,
    position_seconds: 600,
    duration_seconds: 7200,
    completed: false,
    title: 'verifier fixture',
  });

  const state = { userAId: userA.id, staffId: staffUser.id };

  const sections = {
    billing: () => billingChecks({ rpc, payloadFor, service, anon, user: callerA }),
    progress: () => watchProgressChecks({
      rest,
      userA: callerA,
      userB: callerB,
      anonymous: callerAnonUser,
      progressRow: ({ mediaId, forUser }) => ({
        ...progressRow({ mediaId, forUser }),
        user_id: forUser === 'anon' ? anonymousUser?.id : userA.id,
      }),
    }),
    support: () => supportChecks({ rest, userA: callerA, userB: callerB, staff: callerStaff, state }),
  };

  for (const name of only ? [only] : SECTIONS) {
    for (const check of sections[name]()) {
      try {
        record(name, check, await check.run());
      } catch (reason) {
        record(name, check, { ok: false, detail: `threw: ${reason instanceof Error ? reason.message : String(reason)}` });
      }
    }
  }
} finally {
  /*
   * Deleting the users cascades every row they own - progress, tickets,
   * messages, entitlements, staff membership. Best effort and never fatal: a
   * cleanup failure must not turn a clean verification into a red one, and the
   * leftovers are named with this run's namespace.
   */
  for (const id of created) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  if (anonymousUser) await admin.auth.admin.deleteUser(anonymousUser.id).catch(() => undefined);
  await admin.from('billing_webhook_events').delete().eq('provider_event_id', `evt_${namespace}`).then(() => undefined, () => undefined);
}

const failed = results.filter((result) => !result.ok);
console.log();
if (failed.length) {
  console.error(`${failed.length} of ${results.length} checks failed:`);
  for (const failure of failed) console.error(`  [${failure.section}] ${failure.id}`);
  console.error('\nThese are database boundaries. A failure here is a privilege escalation, not a flake.');
  process.exit(1);
}
console.log(`All ${results.length} checks passed.`);
