import { describe, expect, it } from 'vitest';
import {
  NOT_VERIFIED,
  artifactsDeclaredBy,
  assertReadOnly,
  auditSummary,
  classify,
  isVerifiable,
  maskRef,
  nameOf,
  remoteOnly,
  renameCandidates,
  versionOf,
  type AuditRow,
} from '../scripts/lib/migration-audit.mjs';
import auditScript from '../scripts/audit-supabase-migrations.mjs?raw';
import workflow from '../.github/workflows/apply-supabase-migrations.yml?raw';
import watchParties from '../supabase/migrations/20260811044118_watch_parties.sql?raw';
import publicRoomGrant from '../supabase/migrations/20260811164102_public_room_select_grant.sql?raw';
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
  rlsEnabled: new Set<string>(), securityDefiners: new Set<string>(), pinnedSearchPath: new Set<string>(),
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
    rlsEnabled: new Set(declared.rlsEnabled),
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

  it('can now check a grant-only migration, because grants are evidence', () => {
    /* This one used to be unverifiable, when public and anon were filtered out
       of the grant evidence. Keeping them makes it checkable. */
    const declared = artifactsDeclaredBy(publicRoomGrant);
    expect(declared.grants).toContain('watch_rooms:anon');
    expect(isVerifiable(declared)).toBe(true);
  });

  it('excludes a revoke the same migration grants back', () => {
    /*
     * The pattern throughout this repository is "revoke all from public, anon,
     * authenticated" then a narrow grant to authenticated. The end state for
     * that role is granted, so checking the revoke alone would report every
     * correctly-secured table here as missing one.
     */
    const declared = artifactsDeclaredBy(watchProgress);
    expect(declared.grants).toContain('watch_progress:authenticated');
    expect(declared.revokes).toEqual(['watch_progress:public', 'watch_progress:anon']);
    expect(declared.revokes).not.toContain('watch_progress:authenticated');
  });

  it('splits version and name the way the history table stores them', () => {
    expect(versionOf('20260903190000_watch_progress.sql')).toBe('20260903190000');
    expect(nameOf('20260903190000_watch_progress.sql')).toBe('watch_progress');
    expect(versionOf('nope.sql')).toBeNull();
  });
});

describe('the verdict is a lead, never an instruction', () => {
  it('needs nothing else once the exact version is recorded', () => {
    expect(classify(artifactsDeclaredBy(watchProgress), EMPTY, { inHistory: true }).status)
      .toBe('history_match');
  });

  it('has no status meaning proven equivalent', () => {
    /*
     * The defect this replaced: a full house of checked artifacts was called
     * "equivalent" and a repair command was printed from it. Names and
     * existence are syntax; equivalence is semantics. A policy with the right
     * name and an inverted USING clause passes every check in this file.
     */
    const everything = classify(artifactsDeclaredBy(watchProgress), liveFor(watchProgress), { inHistory: false });
    expect(everything.status).toBe('schema_present_candidate');
    expect(everything.status).not.toBe('equivalent');
  });

  it('sends a renamed migration to manual review, whatever the schema says', () => {
    const verdict = classify(artifactsDeclaredBy(watchProgress), liveFor(watchProgress), {
      inHistory: false, sameNameRemoteVersion: '20260811044118',
    });
    expect(verdict.status).toBe('same_name_candidate');
    expect(verdict.sameNameRemoteVersion).toBe('20260811044118');
  });

  it('still reports what is missing when a policy or attribute is absent', () => {
    const live = liveFor(watchProgress);
    live.policies.delete([...live.policies][0]);
    const verdict = classify(artifactsDeclaredBy(watchProgress), live, { inHistory: false });
    expect(verdict.status).not.toBe('schema_present_candidate');
    expect(verdict.missing.some((entry) => entry.startsWith('policy '))).toBe(true);
  });

  it('is absent when none of its primary objects exist', () => {
    expect(classify(artifactsDeclaredBy(supportTickets), EMPTY, { inHistory: false }).status).toBe('absent');
  });

  it('is partial when only some primary objects exist', () => {
    const live = liveWith({ relations: new Set(['support_tickets']) });
    expect(classify(artifactsDeclaredBy(supportTickets), live, { inHistory: false }).status).toBe('partial');
  });

  it('is unverifiable when it declares nothing this audit looks for', () => {
    /* An ALTER TABLE constraint is exactly the sort of thing listed in
       NOT_VERIFIED - the audit cannot see it, and says so rather than guessing. */
    const constraintOnly = 'alter table public.watch_rooms add constraint room_code_len check (length(code) = 6);';
    expect(isVerifiable(artifactsDeclaredBy(constraintOnly))).toBe(false);
    expect(classify(artifactsDeclaredBy(constraintOnly), liveWith({ relations: new Set(['watch_rooms']) }), { inHistory: false }).status)
      .toBe('unverifiable');
  });

  it('names what it never examined', () => {
    /* Printed with every result, so a "present" column is not read as a clean
       bill of health. */
    const text = NOT_VERIFIED.join(' ').toLowerCase();
    for (const aspect of ['using', 'function bodies', 'column-level grants', 'revoke', 'constraints', 'ownership', 'trigger', 'index columns']) {
      expect(text).toContain(aspect);
    }
  });
});

describe('grant evidence keeps the roles that matter', () => {
  it('does not drop public or anon', () => {
    /*
     * An earlier version filtered exactly these out. This repository secures a
     * table by revoking from public and anon and granting narrowly back, so
     * dropping them discards the half of the evidence that matters.
     */
    const declared = artifactsDeclaredBy(watchProgress);
    expect(declared.revokes.some((entry) => entry.endsWith(':public'))).toBe(true);
    expect(declared.revokes.some((entry) => entry.endsWith(':anon'))).toBe(true);
    expect(declared.grants.every((entry) => !/:(public|anon)$/.test(entry) || true)).toBe(true);

    const withAnonGrant = artifactsDeclaredBy('grant select on public.thing to anon, authenticated;');
    expect(withAnonGrant.grants).toContain('thing:anon');
  });

  it('treats a revoke as satisfied only when the role holds no table privilege', () => {
    const sql = 'create table public.t (id int);\nrevoke all on public.t from anon;';
    const declared = artifactsDeclaredBy(sql);
    const denied = classify(declared, liveWith({ relations: new Set(['t']) }), { inHistory: false });
    expect(denied.present).toContain('revoked t:anon (table level only)');

    const stillGranted = classify(declared, liveWith({ relations: new Set(['t']), grants: new Set(['t:anon']) }), { inHistory: false });
    expect(stillGranted.missing).toContain('revoked t:anon (table level only)');
  });

  it('notices row level security being switched on', () => {
    const declared = artifactsDeclaredBy(watchProgress);
    expect(declared.rlsEnabled).toEqual(['watch_progress']);
    const off = classify(declared, { ...liveFor(watchProgress), rlsEnabled: new Set<string>() }, { inHistory: false });
    expect(off.missing).toContain('rls enabled watch_progress');
  });
});

describe('the summary offers no repair list', () => {
  const rows: AuditRow[] = [
    { version: '1', status: 'history_match', missing: [], present: [] },
    { version: '2', status: 'same_name_candidate', missing: [], present: [] },
    { version: '3', status: 'schema_present_candidate', missing: [], present: [] },
    { version: '4', status: 'partial', missing: [], present: [] },
    { version: '5', status: 'absent', missing: [], present: [] },
    { version: '6', status: 'unverifiable', missing: [], present: [] },
  ];

  it('has no bucket that authorizes writing history', () => {
    const summary = auditSummary(rows);
    expect(Object.keys(summary).sort()).toEqual([
      'historyMatch', 'partial', 'pending', 'sameNameCandidates',
      'schemaPresentCandidates', 'unverifiable',
    ]);
    expect(summary).not.toHaveProperty('repairable');
  });

  it('groups every status without promoting any of them', () => {
    const summary = auditSummary(rows);
    expect(summary.historyMatch.map((row) => row.version)).toEqual(['1']);
    expect(summary.sameNameCandidates.map((row) => row.version)).toEqual(['2']);
    expect(summary.schemaPresentCandidates.map((row) => row.version)).toEqual(['3']);
    expect(summary.partial.map((row) => row.version)).toEqual(['4']);
    expect(summary.pending.map((row) => row.version)).toEqual(['5']);
    expect(summary.unverifiable.map((row) => row.version)).toEqual(['6']);
  });

  it('the only action it implies is pushing what was never applied', () => {
    expect(auditSummary(rows).pending.map((row) => row.version)).toEqual(['5']);
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
    /* A shared name is evidence for a human. Nothing promotes it. */
    const summary = auditSummary(renamed.map((entry) => ({ ...entry, status: 'same_name_candidate' } as AuditRow)));
    expect(summary.sameNameCandidates).toHaveLength(8);
    expect(summary).not.toHaveProperty('repairable');
  });

  /*
   * The fixtures above are the drift as it stood before this reconciliation and
   * are deliberately frozen there. This one reads the directory as it is now,
   * so the two cannot silently converge on a stale answer: once the local files
   * carry the versions the project recorded, there is nothing left to rename and
   * no history entry without a file. If someone adds a migration whose version
   * collides with recorded history, or removes one of the recovered hotfixes,
   * this fails.
   */
  it('leaves no drift in the migrations directory as it stands now', () => {
    const current = Object.keys(import.meta.glob('../supabase/migrations/*.sql', { eager: false }))
      .map((path) => path.split('/').pop()!)
      .sort();

    expect(renameCandidates(current, remote)).toEqual([]);
    expect(remoteOnly(current, remote)).toEqual([]);

    /* Every recorded version now has a file, so a push can only be the roadmap
       migrations that were never applied. */
    const versions = new Set(current.map(versionOf));
    for (const entry of remote) expect(versions.has(entry.version)).toBe(true);

    const pending = current.map(versionOf).filter((version) => !remote.some((entry) => entry.version === version));
    expect(pending).toEqual([
      '20260901000000', '20260901120000', '20260903020000', '20260903190000', '20260903210000',
    ]);
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

  it('never constructs a repair command', () => {
    /*
     * The blocker this replaced. The tool may produce evidence; it may not
     * produce an authorization, and the difference has to be structural rather
     * than a matter of how carefully the output is worded.
     */
    expect(auditScript).not.toMatch(/migration repair --status applied/);
    expect(auditScript).not.toMatch(/supabase migration repair/);
    expect(auditScript).not.toMatch(/\.join\(' '\)/);
  });

  it('prints what it never examined, alongside the results', () => {
    expect(auditScript).toContain('WHAT THIS AUDIT DID NOT VERIFY');
    expect(auditScript).toContain('NOT_VERIFIED');
    expect(auditScript).toMatch(/no repair command is printed here/);
  });
});

describe('the workflow keeps repair separate from applying', () => {
  it('describes repair_versions as a hand-reviewed list', () => {
    /* The audit does not produce it and cannot; the input must not read as
       though it does. */
    const input = workflow.slice(workflow.indexOf('repair_versions:'), workflow.indexOf('permissions:'));
    expect(input).toMatch(/reviewed by\s*\n?\s*#?\s*hand|YOU reviewed by hand/);
    expect(input).toContain('The audit does not produce this list');
  });

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
