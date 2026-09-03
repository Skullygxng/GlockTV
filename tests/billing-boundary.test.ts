import { describe, expect, it } from 'vitest';
import { allowedOrigin, corsHeaders } from '../supabase/functions/_shared/cors.ts';
import { createAccountService } from '../src/lib/accountService';
import { createBillingService } from '../src/lib/billing';
import migration from '../supabase/migrations/20260901120000_billing_premium.sql?raw';
import entitlementsMigration from '../supabase/migrations/20260901000000_account_entitlements.sql?raw';
import checkoutSource from '../supabase/functions/create-checkout/index.ts?raw';
import portalSource from '../supabase/functions/create-billing-portal/index.ts?raw';
import webhookSource from '../supabase/functions/stripe-webhook/index.ts?raw';
import billingClientSource from '../src/lib/billing.ts?raw';
import accountPanelSource from '../src/components/AccountPanel.tsx?raw';
import accountServiceSource from '../src/lib/accountService.ts?raw';
import readme from '../README.md?raw';

/*
 * Where the trust boundary is drawn, and proof that nothing crosses it.
 *
 * Two separate things are checked: that no server secret can reach the browser
 * bundle, and that the SQL keeps write authority on the server. Both are the
 * kind of property a future edit could quietly undo, so both are asserted
 * against the real files.
 */

const SERVER_ONLY_SECRETS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ACCESS_TOKEN',
];

describe('secrets never reach the browser', () => {
  const browserSources = [
    ['src/lib/billing.ts', billingClientSource],
    ['src/components/AccountPanel.tsx', accountPanelSource],
    ['src/lib/accountService.ts', accountServiceSource],
  ] as const;

  it.each(browserSources)('%s names no server-only secret', (_name, source) => {
    for (const secret of SERVER_ONLY_SECRETS) {
      expect(source).not.toContain(secret);
    }
  });

  it.each(browserSources)('%s never reads a VITE_ variable for billing', (_name, source) => {
    /*
     * A VITE_ variable is compiled into the bundle and shipped. A billing
     * secret behind one would be public the moment it deployed.
     */
    const viteReads = source.match(/import\.meta\.env\.VITE_[A-Z_]+/g) ?? [];
    for (const read of viteReads) {
      expect(read).not.toMatch(/STRIPE|SERVICE_ROLE|WEBHOOK|ACCESS_TOKEN/);
    }
  });

  it('never exposes a server secret through a VITE_ name anywhere', () => {
    for (const source of [billingClientSource, accountPanelSource, accountServiceSource, readme]) {
      expect(source).not.toMatch(/VITE_[A-Z_]*(STRIPE|SERVICE_ROLE|WEBHOOK_SECRET|ACCESS_TOKEN)/);
    }
    expect(readme).not.toMatch(/VITE_[A-Z_]*(STRIPE|SERVICE_ROLE|WEBHOOK_SECRET|ACCESS_TOKEN)/);
  });

  it('documents every secret by name, and never with a value', () => {
    for (const secret of [...SERVER_ONLY_SECRETS, 'STRIPE_PRICE_PREMIUM_MONTHLY', 'SUPABASE_PROJECT_REF']) {
      expect(readme).toContain(secret);
      // Named in prose, never written as an assignment carrying a value.
      expect(readme).not.toMatch(new RegExp(`^\\s*${secret}\\s*=\\s*\\S`, 'm'));
    }
  });

  it('keeps live Stripe keys out of the repository entirely', () => {
    for (const source of [billingClientSource, accountPanelSource, checkoutSource, portalSource, webhookSource, readme, migration]) {
      expect(source).not.toMatch(/sk_live_[A-Za-z0-9]/);
      expect(source).not.toMatch(/sk_test_[A-Za-z0-9]{8}/);
      expect(source).not.toMatch(/whsec_[A-Za-z0-9]{16}/);
    }
  });
});

describe('the browser billing client can only ask', () => {
  it('exposes exactly two request methods and no mutation', () => {
    const service = createBillingService({ functions: { invoke: async () => ({ data: null, error: null }) } } as never);

    expect(Object.keys(service).sort()).toEqual(['createCheckoutUrl', 'createPortalUrl']);
    for (const name of Object.keys(service)) {
      expect(/premium|tier|entitle|grant|upgrade|activate/i.test(name)).toBe(false);
    }
  });

  it('leaves the account service read-only for entitlements', () => {
    const account = createAccountService({
      auth: { getUser: async () => ({ data: { user: null }, error: null }) },
      from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    } as never);

    // Unchanged by this PR: still no way to write an entitlement from a browser.
    expect(Object.keys(account).sort()).toEqual([
      'linkEmail', 'loadAccount', 'loadEntitlements', 'onAuthChange', 'sendSignInLink',
    ]);
  });

  it('sends no user, customer, price or tier to the server', () => {
    /*
     * The request body is empty on purpose. Every trusted value is derived
     * from the caller's JWT server-side, so there is nothing here to forge.
     */
    expect(billingClientSource).toContain('body: {}');
    expect(billingClientSource).not.toMatch(/body:\s*\{[^}]*(user_?id|customer|price|tier)/i);
  });
});

describe('billing migration keeps write authority on the server', () => {
  const sql = migration.replace(/--[^\n]*/g, '').toLowerCase();

  it('enables row level security on all three tables', () => {
    for (const table of ['billing_customers', 'billing_subscriptions', 'billing_webhook_events']) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toMatch(new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`));
    }
  });

  it('grants the browser nothing but one read of its own subscription', () => {
    const grants = sql.match(/grant [^;]*;/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toBe('grant select on public.billing_subscriptions to authenticated;');
    for (const writer of ['insert', 'update', 'delete', 'all privileges']) {
      expect(grants[0]).not.toContain(writer);
    }
  });

  it('gives the browser no access at all to customer or event tables', () => {
    // Nothing renders a Stripe identifier, so nothing needs to read one.
    expect(sql).not.toMatch(/grant[^;]*billing_customers/);
    expect(sql).not.toMatch(/grant[^;]*billing_webhook_events/);
  });

  it('has exactly one policy, and it is a select of the caller own row', () => {
    const policies = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policies).toHaveLength(1);
    expect(policies[0]).toContain('for select to authenticated');
    expect(policies[0]).toContain('user_id = (select auth.uid())');
    expect(policies[0]).not.toMatch(/for (all|insert|update|delete)\b/);
    expect(policies[0]).not.toContain('with check');
  });

  it('adds no security definer function that could grant a tier', () => {
    expect(sql).not.toContain('security definer');
    expect(sql).not.toContain('create function');
    expect(sql).not.toContain('create or replace function');
  });

  it('does not weaken the account_entitlements policy it depends on', () => {
    const entitlements = entitlementsMigration.replace(/--[^\n]*/g, '').toLowerCase();
    // Still select-only for the browser, as the foundation shipped it.
    expect(entitlements).toContain('grant select on public.account_entitlements to authenticated');
    /* This migration may name that table in prose, but must not touch it: no
       alter, no new grant, no new policy that could widen browser access. */
    expect(sql).not.toMatch(/alter table public\.account_entitlements/);
    expect(sql).not.toMatch(/grant[^;]*account_entitlements/);
    expect(sql).not.toMatch(/create policy[^;]*account_entitlements/);
  });

  it('alters no existing table', () => {
    const alters = [...new Set(sql.match(/alter table (public\.\w+)/g) ?? [])];
    expect(alters.sort()).toEqual([
      'alter table public.billing_customers',
      'alter table public.billing_subscriptions',
      'alter table public.billing_webhook_events',
    ]);
    expect(sql).not.toContain('drop table');
  });
});

describe('edge function entrypoints', () => {
  it('authenticate the caller from their JWT, never from the body', () => {
    for (const source of [checkoutSource, portalSource]) {
      expect(source).toContain('authenticateRequest');
      expect(source).toContain("request.headers.get('authorization')");
      // No path reads a user id out of the request body.
      expect(source).not.toMatch(/request\.json\(\)/);
      expect(source).not.toMatch(/body\.(user_?id|customer|price|tier)/i);
    }
  });

  it('take the price from the server environment only', () => {
    expect(checkoutSource).toContain("Deno.env.get('STRIPE_PRICE_PREMIUM_MONTHLY')");
    expect(checkoutSource).not.toMatch(/price[iI]d\s*[:=]\s*(body|payload|request)/);
  });

  it('verify the webhook signature over the raw body and accept no JWT', () => {
    expect(webhookSource).toContain('verifyStripeSignature');
    expect(webhookSource).toContain("request.headers.get('stripe-signature')");
    // Text, not json(): re-serializing would change the signed bytes.
    expect(webhookSource).toContain('await request.text()');
    expect(webhookSource).not.toContain('authenticateRequest');
  });

  it('return a non-2xx when the signature does not verify, before parsing anything', () => {
    const guard = webhookSource.indexOf('if (!verification.ok)');
    const rejection = webhookSource.indexOf("new Response('Invalid signature', { status: 400 })");
    const parse = webhookSource.indexOf('JSON.parse(rawBody)');

    expect(guard).toBeGreaterThan(-1);
    expect(rejection).toBeGreaterThan(guard);
    // Nothing is parsed or applied until the signature has been accepted.
    expect(parse).toBeGreaterThan(rejection);
  });

  it('never return a secret in a response body', () => {
    for (const source of [checkoutSource, portalSource, webhookSource]) {
      expect(source).not.toMatch(/(JSON\.stringify|new Response)\([^)]*(serviceRoleKey|stripeKey|webhookSecret)/);
    }
  });
});

describe('CORS on the browser-callable functions', () => {
  it('allows the production origin', () => {
    expect(allowedOrigin('https://skullygxng.github.io')).toBe('https://skullygxng.github.io');
  });

  it('refuses an origin that merely looks like it', () => {
    for (const origin of [
      'https://skullygxng.github.io.evil.test',
      'https://evil.test',
      'http://skullygxng.github.io',
      'null',
      '',
      null,
    ]) {
      expect(allowedOrigin(origin)).toBeNull();
    }
  });

  it('never reflects an arbitrary origin and never wildcards', () => {
    expect(corsHeaders(allowedOrigin('https://evil.test'))).toEqual({});
    const headers = corsHeaders(allowedOrigin('https://skullygxng.github.io'));
    expect(headers['Access-Control-Allow-Origin']).toBe('https://skullygxng.github.io');
    expect(headers['Access-Control-Allow-Origin']).not.toBe('*');
    // Responses differ per origin, so shared caches must not reuse them.
    expect(headers.Vary).toBe('Origin');
  });

  it('refuses a disallowed origin before doing any work', () => {
    for (const source of [checkoutSource, portalSource]) {
      expect(source).toMatch(/if \(!origin\) return new Response\('Origin not allowed', \{ status: 403 \}\)/);
    }
  });
});
