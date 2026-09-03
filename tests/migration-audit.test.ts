import { describe, expect, it } from 'vitest';
import {
  artifactsDeclaredBy,
  assertReadOnly,
  classify,
  isVerifiable,
  maskRef,
  nameOf,
  reconciliationPlan,
  remoteOnly,
  renameCandidates,
  versionOf,
  type AuditRow,
} from '../scripts/lib/migration-audit.mjs';
import auditScript from '../scripts/audit-supabase-migrations.mjs?raw';
import workflow from '../.github/workflows/apply-supabase-migrations.yml?raw';
import watchParties from '../supabase/migrations/20260811010000_watch_parties.sql?raw';
import publicRoomGrant from '../supabase/migrations/20260811125500_public_room_select_grant.sql?raw';
import watchProgress from '../supabase/migrations/20260903190000_watch_progress.sql?raw';
import supportTickets from '../supabase/migrations/20260903210000_support_tickets.sql?raw';

/*
 * Reconciling a migration history against a database that already has schema.
 *
 * The first version of this audit called a migration "represented" when the
 * tables and functions it creates existed. That is not proof of anything that
 * matters here: a migration also establishes RLS policies, grants, triggers,
 * indexes and whether a function is SECURITY DEFINER with a pinned search_path,
 * and every one of those can be absent while the table sits there looking
 * correct. Repairing on that basis writes the migration out of the history with
 * its policies still missing, and nothing ever applies them.
 */

const EMPTY = {
  relations: new Set<string>(), functions: new Set<string>(), policies: new Set<string>(),
  triggers: new Set<string>(), indexes: new Set<string>(), grants: new Set<string>(),
  securityDefiners: new Set<string>(), pinnedSearchPath: new Set<string>(),
};
const liveWith = (overrides: Partial<typeof EMPTY>) => ({ ...EMPTY, ...overrides });

/* Everything a migration declares, satisfied. */
function liveFor(sql: string) {
  const declared = artifactsDeclaredBy(sql);
  return {
    relations: new Set([...declared.tables, ...declared.views]),
    functions: new Set(declared.functions),
    policies: new Set(declared.policies),
    triggers: new Set(declared.triggers),
    indexes: new Set(declared.indexes),
    grants: new Set(declared.grants),
    securityDefiners: new Set(declared.securityDefiners),
    pinnedSearchPath: new Set(declared.pinnedSearchPath),
  };
}

describe('reading what a migration establishes', () => {
  it('sees far more than the objects it creates', () => {
    /* The tables were never the security-relevant part. */
    const declared = artifactsDeclaredBy(watchProgress);
    expect(declared.tables).toEqual(['watch_progress']);
    expect(declared.policies.length).toBe(4);
    expect(declared.triggers).toEqual(['watch_progress_stamp_updated_at']);
    expect(declared.indexes).toEqual(['watch_progress_user_recent_idx']);
    expect(declared.grants.length).toBeGreaterThan(0);
    expect(declared.pinnedSearchPath).toContain('stamp_watch_progress_updated_at');
  });

  it('notices which functions are security definer with a pinned search_path', () => {
    const declared = artifactsDeclaredBy(supportTickets);
    expect(declared.securityDefiners.sort())
      .toEqual(['is_support_staff', 'set_support_message_author_role', 'touch_support_ticket']);
    expect(declared.pinnedSearchPath.sort()).toEqual(declared.securityDefiners.sort());
  });

  it('reads statements, not the prose around them', () => {
    /*
     * These files explain at length what they deliberately leave alone. A
     * migration saying so in the obvious words would otherwise be credited with
     * creating the very thing it promises to avoid. No migration is written
     * that way today, so this uses input that actually would fool a naive scan
     * rather than the current files, which would pass either way.
     */
    const misleading = [
      '-- This does not create table public.watch_rooms; that lives elsewhere.',
      "/* Nor create policy \"Members can view their rooms\" on public.watch_rooms. */",
      'create table if not exists public.watch_progress (user_id uuid);',
    ].join('\n');
    const declared = artifactsDeclaredBy(misleading);
    expect(declared.tables).toEqual(['watch_progress']);
    expect(declared.policies).toEqual([]);
  });

  it('reports a grant-only migration as declaring nothing checkable', () => {
    expect(isVerifiable(artifactsDeclaredBy(publicRoomGrant))).toBe(false);
  });

  it('splits version and name the way the history table stores them', () => {
    expect(versionOf('20260903190000_watch_progress.sql')).toBe('20260903190000');
    expect(nameOf('20260903190000_watch_progress.sql')).toBe('watch_progress');
    expect(versionOf('nope.sql')).toBeNull();
  });
});

describe('the verdict is reluctant', () => {
  it('needs nothing else once the exact version is recorded', () => {
    const verdict = classify(artifactsDeclaredBy(watchProgress), EMPTY, { inHistory: true });
    expect(verdict.status).toBe('history_match');
  });

  it('is equivalent only when every declared artifact is present', () => {
    const verdict = classify(artifactsDeclaredBy(watchProgress), liveFor(watchProgress), { inHistory: false });
    expect(verdict.status).toBe('equivalent');
    expect(verdict.missing).toEqual([]);
  });

  it('refuses to call a migration equivalent when its table exists but a policy does not', () => {
    /*
     * The exact case that makes object-existence unsafe. Repairing this writes
     * the migration out of the history while its RLS is still missing, and
     * nothing will ever apply it.
     */
    const live = liveFor(watchProgress);
    live.policies.delete([...live.policies][0]);
    const verdict = classify(artifactsDeclaredBy(watchProgress), live, { inHistory: false });
    expect(verdict.status).toBe('schema_candidate');
    expect(verdict.status).not.toBe('equivalent');
    expect(verdict.missing.some((entry) => entry.startsWith('policy '))).toBe(true);
  });

  it('refuses when a function exists but is not security definer', () => {
    const live = liveFor(supportTickets);
    live.securityDefiners.delete('is_support_staff');
    expect(classify(artifactsDeclaredBy(supportTickets), live, { inHistory: false }).status)
      .toBe('schema_candidate');
  });

  it('refuses when a security definer function has no pinned search_path', () => {
    const live = liveFor(supportTickets);
    live.pinnedSearchPath.delete('is_support_staff');
    expect(classify(artifactsDeclaredBy(supportTickets), live, { inHistory: false }).status)
      .toBe('schema_candidate');
  });

  it('refuses when a trigger or a grant is missing', () => {
    for (const key of ['triggers', 'grants'] as const) {
      const live = liveFor(watchProgress);
      live[key].delete([...live[key]][0]);
      expect(classify(artifactsDeclaredBy(watchProgress), live, { inHistory: false }).status)
        .toBe('schema_candidate');
    }
  });

  it('is absent when none of its primary objects exist', () => {
    expect(classify(artifactsDeclaredBy(supportTickets), EMPTY, { inHistory: false }).status).toBe('absent');
  });

  it('is partial when only some primary objects exist', () => {
    const live = liveWith({ relations: new Set(['support_tickets']) });
    expect(classify(artifactsDeclaredBy(supportTickets), live, { inHistory: false }).status).toBe('partial');
  });

  it('is unverifiable when it declares nothing this audit can check', () => {
    const verdict = classify(artifactsDeclaredBy(publicRoomGrant), liveWith({ relations: new Set(['watch_rooms']) }), { inHistory: false });
    expect(verdict.status).toBe('unverifiable');
  });
});

describe('what may be acted on', () => {
  const rows: AuditRow[] = [
    { version: '1', status: 'history_match', missing: [], present: [] },
    { version: '2', status: 'equivalent', missing: [], present: [] },
    { version: '3', status: 'schema_candidate', missing: ['policy x'], present: [] },
    { version: '4', status: 'partial', missing: [], present: [] },
    { version: '5', status: 'absent', missing: [], present: [] },
    { version: '6', status: 'unverifiable', missing: [], present: [] },
  ];

  it('offers only proven equivalence for repair', () => {
    const plan = reconciliationPlan(rows);
    expect(plan.repairable.map((row) => row.version)).toEqual(['2']);
  });

  it('never sweeps an unverifiable migration in behind a neighbour', () => {
    /*
     * "Creates no object" means this audit cannot prove it, not that it follows
     * another migration safely. The previous version appended these to the
     * repair command, which would have recorded them applied on no evidence.
     */
    const plan = reconciliationPlan(rows);
    expect(plan.repairable.map((row) => row.version)).not.toContain('6');
    expect(plan.unverifiable.map((row) => row.version)).toEqual(['6']);
  });

  it('keeps schema candidates and partials out of both action buckets', () => {
    const plan = reconciliationPlan(rows);
    for (const bucket of [plan.repairable, plan.pending]) {
      expect(bucket.map((row) => row.version)).not.toContain('3');
      expect(bucket.map((row) => row.version)).not.toContain('4');
    }
    expect(plan.schemaCandidates.map((row) => row.version)).toEqual(['3']);
    expect(plan.partial.map((row) => row.version)).toEqual(['4']);
  });

  it('proposes pushing only what is absent', () => {
    expect(reconciliationPlan(rows).pending.map((row) => row.version)).toEqual(['5']);
  });
});

describe('the real drift this project has', () => {
  /* The history read from the live project, as reported by the reviewer. */
  const remote = [
    ['20260811044118', 'watch_parties'], ['20260811044451', 'watch_party_advisor_fixes'],
    ['20260811065428', 'watch_party_title_changes'], ['20260811163336', 'full_title_watch_rooms'],
    ['20260811163453', 'public_room_read_policy'], ['20260811164102', 'public_room_select_grant'],
    ['20260818023419', 'preserve_room_when_host_leaves'], ['20260818030935', 'host_member_moderation'],
    ['20260818031228', 'index_room_bans_user'], ['20260818044028', 'room_reliability_suite'],
    ['20260818044118', 'room_report_index'],
    ['20260828044659', 'official_lounge_vote_authorization_hotfix'],
    ['20260828045110', 'official_lounge_vote_conflict_hotfix'],
  ].map(([version, name]) => ({ version, name }));

  const local = [
    '20260811010000_watch_parties.sql', '20260811011000_watch_party_advisor_fixes.sql',
    '20260811030000_watch_party_title_changes.sql', '20260811123000_full_title_watch_rooms.sql',
    '20260811124500_public_room_read_policy.sql', '20260811125500_public_room_select_grant.sql',
    '20260818023419_preserve_room_when_host_leaves.sql', '20260818030935_host_member_moderation.sql',
    '20260818031228_index_room_bans_user.sql', '20260818042433_room_reliability_suite.sql',
    '20260818044105_room_report_index.sql', '20260827070000_official_lounge_rotation.sql',
    '20260828020000_official_lounge_vote_authorization.sql', '20260901000000_account_entitlements.sql',
    '20260901120000_billing_premium.sql', '20260903020000_billing_atomic_and_expiry.sql',
    '20260903190000_watch_progress.sql', '20260903210000_support_tickets.sql',
  ];

  it('has three exact version matches, so the intersection is not empty', () => {
    /* Asserted because it was claimed to be empty once, from a dry run rather
       than from the history itself. */
    const remoteVersions = new Set(remote.map((entry) => entry.version));
    const exact = local.map(versionOf).filter((version) => remoteVersions.has(version!));
    expect(exact).toEqual(['20260818023419', '20260818030935', '20260818031228']);
  });

  it('finds eight renamed migrations as leads, not verdicts', () => {
    const renamed = renameCandidates(local, remote);
    expect(renamed.map((entry) => entry.name)).toEqual([
      'watch_parties', 'watch_party_advisor_fixes', 'watch_party_title_changes',
      'full_title_watch_rooms', 'public_room_read_policy', 'public_room_select_grant',
      'room_reliability_suite', 'room_report_index',
    ]);
    /* A shared name is evidence for a human. Nothing here promotes it. */
    expect(reconciliationPlan(renamed.map((entry) => ({ ...entry, status: 'schema_candidate' } as AuditRow))).repairable)
      .toEqual([]);
  });

  it('finds two history entries this repository does not contain', () => {
    /* The database has changes the repo does not; a push touching the same
       objects could contradict them. */
    expect(remoteOnly(local, remote).map((entry) => entry.name)).toEqual([
      'official_lounge_vote_authorization_hotfix',
      'official_lounge_vote_conflict_hotfix',
    ]);
  });
});

describe('the audit only ever reads', () => {
  it('accepts a single select and refuses everything else', () => {
    expect(assertReadOnly('select version from supabase_migrations.schema_migrations;'))
      .toBe('select version from supabase_migrations.schema_migrations');
    for (const sql of [
      'delete from watch_rooms', 'update account_entitlements set tier = $$premium$$',
      'insert into staff_members values (1)', 'drop table watch_progress', 'truncate chat_messages',
      'select 1; drop table watch_rooms',
    ]) {
      expect(() => assertReadOnly(sql)).toThrow(/non-SELECT/);
    }
  });

  it('sends nothing that did not go through the guard', () => {
    expect(auditScript).toContain('assertReadOnly(sql)');
    expect(auditScript).not.toMatch(/\b(insert|update|delete|drop|truncate|alter)\s+(into|from|table)\b/i);
  });

  it('prints enough of the project ref to compare it, and no more', () => {
    /* A dry run disagreeing with the dashboard is usually two projects. This
       has to be decidable without publishing the ref. */
    const masked = maskRef('abcdefghijklmnopqrst');
    expect(masked).toContain('abcd');
    expect(masked).toContain('qrst');
    expect(masked).not.toContain('efghijklmnop');
    expect(maskRef('')).toMatch(/unset/);
    expect(auditScript).toContain('PROJECT IDENTITY');
    expect(auditScript).toContain('maskRef(ref)');
  });

  it('says so when the exact matches contradict the push', () => {
    expect(auditScript).toContain('EXACT VERSION MATCHES');
    expect(auditScript).toMatch(/must not list them as/);
  });
});

describe('the workflow keeps repair separate from applying', () => {
  it('repairs only when versions are explicitly supplied', () => {
    /* Bounded to this step: an unbounded slice runs into "Re-audit after
       repair", which carries the same condition, so a deleted guard would
       still be found. */
    const repair = workflow.slice(
      workflow.indexOf('- name: Repair migration history'),
      workflow.indexOf('- name: Re-audit after repair'),
    );
    expect(repair).toContain("if: ${{ inputs.repair_versions != '' }}");
    expect(workflow).toMatch(/repair_versions:[\s\S]*?default: ''/);
  });

  it('validates the versions instead of interpolating them into a shell', () => {
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
