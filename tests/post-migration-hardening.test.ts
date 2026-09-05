import { describe, expect, it } from 'vitest';
import { splitStatements } from '../scripts/lib/migration-sql-compare.mjs';
import hardening from '../supabase/migrations/20260905213000_harden_trigger_function_grants.sql?raw';
import supportMigration from '../supabase/migrations/20260903210000_support_tickets.sql?raw';
import progressMigration from '../supabase/migrations/20260903190000_watch_progress.sql?raw';
import billingMigration from '../supabase/migrations/20260901120000_billing_premium.sql?raw';
import entitlementsMigration from '../supabase/migrations/20260901000000_account_entitlements.sql?raw';
import atomicMigration from '../supabase/migrations/20260903020000_billing_atomic_and_expiry.sql?raw';

/*
 * Assertions about what this migration DOES run against the parsed statements,
 * not the file text. The file explains at length which functions it leaves
 * alone and what a rollback would look like, and a raw-text search credits it
 * with doing the things it is promising not to do.
 */
const statements = splitStatements(hardening);
const executed = statements.join('\n');

const ALL_FIVE = [
  entitlementsMigration, billingMigration, atomicMigration, progressMigration, supportMigration,
];

describe('trigger-only functions are not executable by browser roles', () => {
  /* All three return trigger. PostgreSQL refuses to invoke a trigger function
     directly, so this is defence in depth rather than a live hole - but the
     default PUBLIC grant is still not what any of them wants. */
  const triggerOnly = [
    'set_support_message_author_role',
    'touch_support_ticket',
    'stamp_watch_progress_updated_at',
  ];

  for (const fn of triggerOnly) {
    it(`revokes execute on ${fn} from public, anon and authenticated`, () => {
      expect(statements).toContain(
        `revoke all on function public.${fn}() from public, anon, authenticated`,
      );
    });

    it(`${fn} is genuinely trigger-only, so revoking cannot break a caller`, () => {
      const source = ALL_FIVE.find((sql) => sql.includes(`function public.${fn}()`));
      expect(source).toBeDefined();
      const declaration = source!.slice(source!.indexOf(`function public.${fn}()`));
      expect(declaration.slice(0, 120)).toContain('returns trigger');
      /* And it is actually wired to a trigger, so the revoke leaves it working. */
      expect(source).toMatch(new RegExp(`execute function public\\.${fn}\\(\\)`));
    });
  }

  it('grants execute back to nobody, because nothing calls these directly', () => {
    expect(executed).not.toMatch(/grant execute/i);
  });

  it('leaves the deliberately callable functions alone', () => {
    /* is_support_staff and apply_billing_provider_state are browser-callable on
       purpose and already revoke the PUBLIC default themselves. The file names
       both in a comment explaining why, so this reads the statements. */
    expect(executed).not.toContain('is_support_staff');
    expect(executed).not.toContain('apply_billing_provider_state');
  });
});

describe('the one uncovered foreign key', () => {
  it('indexes support_messages.author_id', () => {
    expect(statements).toContain(
      'create index if not exists support_messages_author_idx on public.support_messages (author_id)',
    );
  });

  it('does not touch the foreign keys that are already covered', () => {
    /* Every other FK leads a primary key or an existing index. Adding more
       would be the "unused index" the advisor complains about next. */
    for (const covered of [
      'support_messages_ticket_idx', 'support_tickets_user_recent_idx',
      'support_tickets_status_idx', 'watch_progress_user_recent_idx',
      'billing_customers_provider_customer_idx', 'billing_subscriptions_customer_idx',
    ]) {
      expect(executed).not.toContain(`create index if not exists ${covered}`);
    }
  });

  it('drops no index, however unused a fresh one looks', () => {
    expect(executed).not.toMatch(/drop\s+index/i);
  });
});

describe('what this migration deliberately does not change', () => {
  it('creates, drops or alters no policy', () => {
    expect(executed).not.toMatch(/create\s+policy|drop\s+policy|alter\s+policy/i);
  });

  it('issues no table grant and no table revoke', () => {
    expect(executed).not.toMatch(/grant\s+(select|insert|update|delete)/i);
    expect(executed).not.toMatch(/revoke\s+all\s+on\s+public\./i);
  });

  it('alters no table and creates no table, view or function', () => {
    expect(executed).not.toMatch(/alter\s+table|create\s+table|create\s+(or replace\s+)?view/i);
    expect(executed).not.toMatch(/create\s+(or replace\s+)?function/i);
  });

  it('does not disable row level security anywhere', () => {
    expect(executed).not.toMatch(/disable\s+row\s+level\s+security/i);
  });

  it('touches no watch-room or lounge object', () => {
    for (const untouched of [
      'watch_rooms', 'room_members', 'chat_messages', 'official_lounge',
      'cast_official_lounge_vote', 'send_watch_room_message', 'apply_official_lounge_title',
    ]) {
      expect(executed).not.toContain(untouched);
    }
  });
});

describe('the advisor findings that were already satisfied before this PR', () => {
  /* Reported rather than "fixed": rewriting these would have been a no-op
     commit that made the diff look like it did something. */
  it('every auth.uid() and auth.jwt() in the five migrations is already an InitPlan subquery', () => {
    for (const sql of ALL_FIVE) {
      const calls = [...sql.matchAll(/auth\.(uid|jwt)\s*\(/g)];
      for (const call of calls) {
        const before = sql.slice(Math.max(0, call.index! - 20), call.index!);
        expect(before).toMatch(/\(\s*select\s+$/);
      }
    }
  });

  it('names the three tables that are locked by absent grant rather than by policy', () => {
    /* RLS-enabled-no-policy is correct here: with no grant, PostgREST refuses
       the relation before RLS is consulted, which is stricter than any policy. */
    for (const table of ['billing_customers', 'billing_webhook_events', 'staff_members']) {
      const source = table === 'staff_members' ? supportMigration : billingMigration;
      expect(source).toContain(`alter table public.${table} enable row level security;`);
      expect(source).toContain(`revoke all on public.${table} from public, anon, authenticated;`);
      expect(source).not.toMatch(new RegExp(`grant\\s+\\w+[^;]*\\son\\s+public\\.${table}\\s+to`, 'i'));
    }
  });

  it('keeps every policy scoped to authenticated, never to anon or public', () => {
    for (const sql of ALL_FIVE) {
      for (const match of sql.matchAll(/^on public\.[a-z_]+ for \w+ to (\w+)/gm)) {
        expect(match[1]).toBe('authenticated');
      }
    }
  });

  it('keeps anonymous sessions out of every write path', () => {
    /* Supabase anonymous sign-ins hold the authenticated role, which is why the
       advisor flags these tables. The guard is the jwt claim, not the role. */
    const anonymousGuard = /coalesce\(\(select auth\.jwt\(\) ->> 'is_anonymous'\)::boolean, false\) = false/;
    const writePolicies = [
      progressMigration.slice(progressMigration.indexOf('"Viewers record their own progress"')),
      progressMigration.slice(progressMigration.indexOf('"Viewers update their own progress"')),
      supportMigration.slice(supportMigration.indexOf('"Customers open their own tickets"')),
    ];
    for (const policy of writePolicies) expect(policy.slice(0, 700)).toMatch(anonymousGuard);
  });
});
