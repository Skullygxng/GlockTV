import { describe, expect, it } from 'vitest';
import readme from '../README.md?raw';
import deployFunctions from '../.github/workflows/deploy-supabase-functions.yml?raw';
import applyMigrations from '../.github/workflows/apply-supabase-migrations.yml?raw';
import smokeTest from '../scripts/verify-billing-permissions.mjs?raw';
import { SUBSCRIPTION_EVENTS } from '../supabase/functions/_shared/billing';

/*
 * Phase 0 activation tooling.
 *
 * None of this changes how billing behaves. It exists because the gap between
 * "the code is merged" and "the product takes payments" is a list of external
 * steps, and every one of them has already failed silently once: the function
 * deploy died inside the CLI with a message about login rather than about a
 * missing repository secret, and the webhook event list lived only in prose
 * that nothing kept in step with the code.
 */

describe('function deployment names what is missing', () => {
  it('fails before the CLI runs when either deployment secret is absent', () => {
    const guard = deployFunctions.slice(
      deployFunctions.indexOf('Require deployment secrets'),
      deployFunctions.indexOf('Set up Supabase CLI'),
    );

    /* The guard has to come first, or the CLI reports the symptom instead. */
    expect(guard).toContain('SUPABASE_ACCESS_TOKEN');
    expect(guard).toContain('SUPABASE_PROJECT_REF');
    expect(guard).toContain('exit 1');
    expect(deployFunctions.indexOf('Require deployment secrets'))
      .toBeLessThan(deployFunctions.indexOf('supabase/setup-cli'));
  });

  it('still deploys only the three billing functions', () => {
    const deployed = [...deployFunctions.matchAll(/supabase functions deploy (\S+)/g)].map((m) => m[1]);
    expect(deployed).toEqual(['create-checkout', 'create-billing-portal', 'stripe-webhook']);
  });
});

describe('migrations are applied deliberately', () => {
  it('is dispatch-only, so no push can mutate the database', () => {
    const triggers = applyMigrations.slice(0, applyMigrations.indexOf('permissions:'));
    expect(triggers).toContain('workflow_dispatch');
    expect(triggers).not.toMatch(/^on:\s*\n\s+push:/m);
    expect(triggers).not.toContain('pull_request');
  });

  it('defaults to a dry run and only applies when it is switched off', () => {
    expect(applyMigrations).toMatch(/dry_run:[\s\S]*?default: true/);
    const apply = applyMigrations.slice(applyMigrations.indexOf('name: Apply migrations'));
    expect(apply).toContain('inputs.dry_run == false');
    expect(apply).toMatch(/run: supabase db push\s*$/);
  });

  it('refuses to run without the database password rather than half-linking', () => {
    expect(applyMigrations).toContain('SUPABASE_DB_PASSWORD');
    expect(applyMigrations.indexOf('Require database secrets'))
      .toBeLessThan(applyMigrations.indexOf('supabase link'));
  });

  it('queues concurrent runs instead of interleaving DDL', () => {
    expect(applyMigrations).toMatch(/group: supabase-migrations[\s\S]*?cancel-in-progress: false/);
  });
});

describe('the permission smoke test asks the real project', () => {
  it('covers all three required questions', () => {
    expect(smokeTest).toContain('service-role can execute apply_billing_provider_state');
    expect(smokeTest).toContain('publishable key signed out is refused');
    expect(smokeTest).toContain('publishable key signed in as an ordinary user is refused');
  });

  it('fails the run when any check fails', () => {
    expect(smokeTest).toMatch(/failed\.length[\s\S]*?process\.exit\(1\)/);
  });

  it('takes every credential from the environment and writes none to disk', () => {
    expect(smokeTest).toContain('process.env.SUPABASE_SERVICE_ROLE_KEY');
    expect(smokeTest).not.toMatch(/writeFile|appendFile|createWriteStream/);
    /* A real key must never be committed alongside the test that uses it. */
    expect(smokeTest).not.toMatch(/\b(eyJ[A-Za-z0-9_-]{20,}|sb_secret_\S+|sk_(live|test)_\S+)/);
  });

  it('cannot be satisfied without a real project', () => {
    expect(smokeTest).toMatch(/Missing required environment[\s\S]*?process\.exit\(2\)/);
    /* Two identical keys would compare a role against itself. */
    expect(smokeTest).toContain('serviceRoleKey === publishableKey');
  });

  it('grants no premium while proving the write path', () => {
    expect(smokeTest).toContain("p_tier: 'free'");
    expect(smokeTest).not.toMatch(/p_tier:\s*'premium'/);
  });
});

describe('documented webhook subscription matches the code', () => {
  it('lists exactly the events the function acts on', () => {
    const setup = readme.slice(readme.indexOf('Create a Stripe webhook endpoint'));
    const documented = [...setup.matchAll(
      /`(checkout\.session\.\w+|customer\.subscription\.\w+|invoice\.\w+)`/g,
    )].map((match) => match[1]);

    /*
     * The point of this test: prose drifts. If a branch is added to the webhook
     * the README stops being a correct configuration instruction, and the
     * symptom is a live event nobody is subscribed to.
     */
    expect([...new Set(documented)].sort()).toEqual([...SUBSCRIPTION_EVENTS].sort());
  });

  it('does not tell the operator to subscribe to a wildcard', () => {
    expect(readme).not.toContain('customer.subscription.*');
  });
});
