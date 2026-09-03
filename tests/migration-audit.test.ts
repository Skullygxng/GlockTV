import { describe, expect, it } from 'vitest';
import {
  assertReadOnly,
  classify,
  objectsCreatedBy,
  reconciliationPlan,
  versionOf,
  type AuditRow,
} from '../scripts/lib/migration-audit.mjs';
import auditScript from '../scripts/audit-supabase-migrations.mjs?raw';
import workflow from '../.github/workflows/apply-supabase-migrations.yml?raw';
import watchParties from '../supabase/migrations/20260811010000_watch_parties.sql?raw';
import roomIndex from '../supabase/migrations/20260818031228_index_room_bans_user.sql?raw';
import watchProgress from '../supabase/migrations/20260903190000_watch_progress.sql?raw';
import supportTickets from '../supabase/migrations/20260903210000_support_tickets.sql?raw';
import billingAtomic from '../supabase/migrations/20260903020000_billing_atomic_and_expiry.sql?raw';

/*
 * Reconciling a migration history against a database that already has the
 * schema.
 *
 * `db push --dry-run` says which local versions the remote history does not
 * mention. It never says why, and the two reasons need opposite treatment: a
 * version missing because the change was never made needs pushing, while one
 * missing because the change was made by hand needs its history repaired. Push
 * the second kind and you re-run DDL against live objects.
 */

const remote = (relations: string[], functions: string[] = []) => ({
  relations: new Set(relations),
  functions: new Set(functions),
});

describe('reading what a migration creates', () => {
  it('finds the tables and functions it introduces', () => {
    const objects = objectsCreatedBy(watchParties);
    expect(objects.tables).toEqual(['watch_rooms', 'room_members', 'chat_messages']);
    expect(objects.functions).toContain('is_room_member');
    expect(objects.functions).toContain('create_watch_room');
  });

  it('finds a view as well as a table', () => {
    const objects = objectsCreatedBy(billingAtomic);
    expect(objects.views).toEqual(['account_entitlements_effective']);
    expect(objects.functions).toEqual(['apply_billing_provider_state']);
  });

  it('reads statements, not the prose around them', () => {
    /*
     * These files explain at length what they deliberately leave alone, and a
     * migration that said so in the obvious words would be credited with
     * creating the very thing it promises to avoid - then marked represented
     * against a database holding none of its real tables.
     *
     * No migration is written that way today, so this is asserted against
     * input that would actually fool a naive scan rather than against the
     * current files, which would pass either way and prove nothing.
     */
    const misleading = [
      '-- This does not create table public.watch_rooms; that lives elsewhere.',
      '/* Nor does it create or replace function public.leave_watch_room(uuid). */',
      'create table if not exists public.watch_progress (user_id uuid);',
    ].join('\n');

    const objects = objectsCreatedBy(misleading);
    expect(objects.tables).toEqual(['watch_progress']);
    expect(objects.functions).toEqual([]);
  });

  it('reports the real migrations exactly, as a regression guard', () => {
    /* Separate from the test above: this pins today's files rather than the
       parser's handling of prose. */
    expect(objectsCreatedBy(watchProgress).tables).toEqual(['watch_progress']);
    expect(objectsCreatedBy(supportTickets).tables)
      .toEqual(['staff_members', 'support_tickets', 'support_messages']);
    expect(objectsCreatedBy(supportTickets).tables).not.toContain('watch_progress');
  });

  it('reports nothing for a migration that only adds an index', () => {
    expect(objectsCreatedBy(roomIndex)).toEqual({ tables: [], functions: [], views: [] });
  });

  it('takes the version from the filename, which is what the history stores', () => {
    expect(versionOf('20260903190000_watch_progress.sql')).toBe('20260903190000');
    expect(versionOf('not-a-migration.sql')).toBeNull();
  });
});

describe('deciding whether a migration is already represented', () => {
  const objects = { tables: ['watch_progress'], functions: ['stamp_watch_progress_updated_at'], views: [] };

  it('is represented when everything it creates already exists', () => {
    const verdict = classify(objects, remote(['watch_progress'], ['stamp_watch_progress_updated_at']));
    expect(verdict.status).toBe('represented');
    expect(verdict.missing).toEqual([]);
  });

  it('is absent when none of it exists', () => {
    expect(classify(objects, remote([], [])).status).toBe('absent');
  });

  it('is partial when only some of it exists, which is never safe to act on blindly', () => {
    /*
     * The dangerous middle. Repairing this would record a migration as applied
     * when half of it is not there; pushing it would re-run the half that is.
     * Both are wrong, so it is neither and a human decides.
     */
    const verdict = classify(objects, remote(['watch_progress'], []));
    expect(verdict.status).toBe('partial');
    expect(verdict.present).toEqual(['table watch_progress']);
    expect(verdict.missing).toEqual(['function stamp_watch_progress_updated_at']);
  });

  it('is inconclusive when the migration creates nothing of its own', () => {
    /* A policy, grant or index migration cannot be judged from the schema
       alone; its standing follows the migration it amends. */
    expect(classify({ tables: [], functions: [], views: [] }, remote(['anything'])).status)
      .toBe('inconclusive');
  });

  it('checks functions against functions, not against relations', () => {
    /* A table sharing a name with a function must not vouch for it. */
    const verdict = classify({ tables: [], functions: ['is_support_staff'], views: [] }, remote(['is_support_staff'], []));
    expect(verdict.status).toBe('absent');
  });
});

describe('what the plan proposes', () => {
  const rows: AuditRow[] = [
    { version: '1', inHistory: true, status: 'represented' },
    { version: '2', inHistory: false, status: 'represented' },
    { version: '3', inHistory: false, status: 'inconclusive' },
    { version: '4', inHistory: false, status: 'absent' },
    { version: '5', inHistory: false, status: 'partial' },
  ];

  it('proposes repair only for what the database already has and the history lacks', () => {
    const plan = reconciliationPlan(rows);
    expect(plan.repairable.map((row) => row.version)).toEqual(['2']);
    expect(plan.inconclusive.map((row) => row.version)).toEqual(['3']);
    expect(plan.genuinelyPending.map((row) => row.version)).toEqual(['4']);
  });

  it('never files a partially-present migration as pending or as repairable', () => {
    const plan = reconciliationPlan(rows);
    expect(plan.partial.map((row) => row.version)).toEqual(['5']);
    for (const bucket of [plan.repairable, plan.genuinelyPending, plan.inconclusive]) {
      expect(bucket.map((row) => row.version)).not.toContain('5');
    }
  });

  it('proposes nothing for a migration the history already records', () => {
    expect(reconciliationPlan(rows).repairable.map((row) => row.version)).not.toContain('1');
  });
});

describe('the audit only ever reads', () => {
  it('accepts a single select', () => {
    expect(assertReadOnly('select version from supabase_migrations.schema_migrations;'))
      .toBe('select version from supabase_migrations.schema_migrations');
  });

  it('refuses anything that writes', () => {
    for (const sql of [
      'delete from watch_rooms',
      'update account_entitlements set tier = $$premium$$',
      'insert into staff_members values (1)',
      'drop table watch_progress',
      'truncate chat_messages',
    ]) {
      expect(() => assertReadOnly(sql)).toThrow(/non-SELECT/);
    }
  });

  it('refuses a second statement riding along behind a select', () => {
    expect(() => assertReadOnly('select 1; drop table watch_rooms')).toThrow(/non-SELECT/);
  });

  it('sends nothing but statements that went through the guard', () => {
    const calls = [...auditScript.matchAll(/await query\(/g)];
    expect(calls.length).toBeGreaterThan(0);
    expect(auditScript).toContain('assertReadOnly(sql)');
    expect(auditScript).not.toMatch(/\b(insert|update|delete|drop|truncate|alter)\s+(into|from|table)\b/i);
  });
});

describe('the workflow keeps repair separate from applying', () => {
  it('repairs only when versions are explicitly supplied', () => {
    /*
     * Bounded to this step. An unbounded slice runs on into "Re-audit after
     * repair", which carries the same condition - so deleting the guard here
     * would still find one and the assertion would pass having proved nothing.
     */
    const repair = workflow.slice(
      workflow.indexOf('- name: Repair migration history'),
      workflow.indexOf('- name: Re-audit after repair'),
    );
    expect(repair).toContain("if: ${{ inputs.repair_versions != '' }}");
    expect(workflow).toMatch(/repair_versions:[\s\S]*?default: ''/);
  });

  it('validates the versions instead of interpolating them into a shell', () => {
    /* This input reaches a command line. It arrives through the environment
       and every value is checked to be fourteen digits first. */
    const repair = workflow.slice(
      workflow.indexOf('- name: Repair migration history'),
      workflow.indexOf('- name: Re-audit after repair'),
    );
    expect(repair).toContain('REPAIR_VERSIONS: ${{ inputs.repair_versions }}');
    expect(repair).toContain('Not a migration version');
    expect(repair).not.toMatch(/supabase migration repair[^\n]*\$\{\{/);
  });

  it('still gates the real apply on dry_run alone', () => {
    const apply = workflow.slice(workflow.indexOf('- name: Apply migrations'));
    expect(apply).toContain('inputs.dry_run == false');
    expect(apply).toMatch(/run: supabase db push\s*$/);
    /* Repairing must not become a way to apply. */
    expect(apply).not.toContain('repair');
  });

  it('audits before it repairs, and re-checks after', () => {
    const order = ['Audit migration history', 'Audit local migrations against the live schema',
      'Repair migration history', 'Re-audit after repair', 'List pending migrations', 'Apply migrations'];
    const positions = order.map((name) => workflow.indexOf(`- name: ${name}`));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('is still dispatch-only and dry by default', () => {
    const triggers = workflow.slice(0, workflow.indexOf('permissions:'));
    expect(triggers).toContain('workflow_dispatch');
    expect(triggers).not.toMatch(/^\s+push:/m);
    expect(workflow).toMatch(/dry_run:[\s\S]*?default: true/);
  });
});
