import { describe, expect, it } from 'vitest';
import migration from '../supabase/migrations/20260903190000_watch_progress.sql?raw';
import entitlementsMigration from '../supabase/migrations/20260901000000_account_entitlements.sql?raw';

/*
 * Absence is asserted against the statements, not the file. This migration's
 * header explains at length that it adds no SECURITY DEFINER function and does
 * not touch entitlements or watch parties - so a naive search of the whole file
 * would find every word it promises not to use, and would pass just as happily
 * if the comment were deleted and the thing itself added.
 */
const statements = migration.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/* Grants span several lines now that they name columns, so they are split on
   the statement terminator rather than by line. */
const grantStatements = statements
  .split(';')
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.startsWith('grant ') && chunk.includes('public.watch_progress'));

/*
 * Source-level assertions about the progress table.
 *
 * These read the migration, not a database, and that distinction is the point:
 * they catch a policy that was never written, not a grant the project has since
 * been changed by hand. The properties below are the ones that would let one
 * viewer read or rewrite another's history, so they are worth asserting even
 * against a file - but they are not a substitute for running the migration.
 */

describe('progress is per viewer and enforced by the database', () => {
  it('turns row level security on', () => {
    expect(migration).toMatch(/alter table public\.watch_progress enable row level security/);
  });

  it('takes the default grants away before handing any back', () => {
    /* Revoke first, then grant exactly what is needed: the same order the
       entitlements table established, so one table cannot drift from the other. */
    const revokeAt = statements.indexOf('revoke all on public.watch_progress');
    const grantAt = statements.indexOf('grant select, delete on public.watch_progress');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(revokeAt);
    expect(statements).toMatch(/revoke all on public\.watch_progress from public, anon, authenticated/);
  });

  it('gives the browser role nothing at all', () => {
    /* anon appears only in the revoke. A signed-out visitor keeps progress on
       the device; there is no row for them to reach. */
    expect(grantStatements.length).toBeGreaterThan(0);
    for (const grant of grantStatements) {
      /* The grantee only: "public.watch_progress" is the table's schema, not a
         role, and matching the whole statement would fail on every grant. */
      const grantee = grant.slice(grant.lastIndexOf(' to ') + 4).trim();
      expect(grantee).toBe('authenticated');
    }
  });

  it('scopes every policy to the caller, on both sides of a write', () => {
    const policies = [...migration.matchAll(/create policy "([^"]+)"[\s\S]*?;/g)].map((match) => match[0]);
    expect(policies).toHaveLength(4);

    for (const policy of policies) {
      expect(policy).toMatch(/user_id = \(select auth\.uid\(\)\)/);
      /*
       * An update needs both: using decides which rows may be touched, with
       * check decides what they may become. Without the second, a row could be
       * handed to another user_id on the way out. Each clause is checked for
       * the ownership condition rather than for an exact string, since both
       * now carry the anonymous guard alongside it.
       */
      if (/for update/.test(policy)) {
        const usingClause = policy.slice(policy.indexOf('using ('), policy.indexOf('with check ('));
        const checkClause = policy.slice(policy.indexOf('with check ('));
        expect(usingClause).toMatch(/user_id = \(select auth\.uid\(\)\)/);
        expect(checkClause).toMatch(/user_id = \(select auth\.uid\(\)\)/);
      }
      if (/for insert/.test(policy)) {
        expect(policy.slice(policy.indexOf('with check ('))).toMatch(/user_id = \(select auth\.uid\(\)\)/);
      }
    }
  });

  it('withholds the authoritative timestamp from every write grant', () => {
    /*
     * updated_at is what reconciliation trusts as database time. A browser that
     * can name it can forge cloud recency, so it is absent from the column
     * lists - and the trigger stamps it regardless of how the row arrives.
     */
    const writeGrants = grantStatements.filter((grant) => /^grant (insert|update) \(/.test(grant));
    expect(writeGrants).toHaveLength(2);
    for (const grant of writeGrants) {
      expect(grant).not.toMatch(/\bupdated_at\b/);
    }
    expect(statements).toMatch(/new\.updated_at := now\(\)/);
    expect(statements).toMatch(/before insert or update on public\.watch_progress/);
  });

  it('covers all four verbs it grants', () => {
    for (const verb of ['for select', 'for insert', 'for update', 'for delete']) {
      expect(migration).toContain(verb);
    }
  });

  it('is re-runnable', () => {
    expect(statements).toContain('create table if not exists public.watch_progress');
    expect(statements).toContain('create index if not exists watch_progress_user_recent_idx');
    expect((statements.match(/drop policy if exists/g) ?? [])).toHaveLength(4);
    expect((statements.match(/drop trigger if exists/g) ?? [])).toHaveLength(1);
  });
});

describe('progress needs no privilege', () => {
  it('adds no security definer function', () => {
    /*
     * The distinction that keeps this table safe to let the client write:
     * entitlements need a trusted writer because a browser must not grant
     * itself Premium, while a resume point has no authority to escalate. If a
     * definer function ever appears here it is a new privileged surface and
     * should be reviewed as one.
     */
    expect(statements).not.toMatch(/security definer/i);
    expect(entitlementsMigration).not.toMatch(/grant (insert|update|delete)[^;]*to authenticated/i);
  });

  it('gives the service role no path here', () => {
    expect(statements).not.toMatch(/service_role/);
  });

  it('does not touch entitlements, billing or watch parties', () => {
    for (const table of ['account_entitlements', 'billing_subscriptions', 'watch_rooms', 'room_members']) {
      expect(statements).not.toContain(table);
    }
  });
});

describe('the table matches how it is read', () => {
  it('indexes the Continue Watching query rather than sorting everything', () => {
    /* The read is "my rows, newest first". The primary key leads with user_id
       but says nothing about recency, so without this the sort is a filesort
       over everything the person has ever watched. */
    expect(migration).toMatch(/on public\.watch_progress \(user_id, updated_at desc\)/);
  });

  it('gives one title one row per episode', () => {
    expect(migration).toMatch(/primary key \(user_id, media_type, media_id, season_number, episode_number\)/);
  });

  it('refuses values the client layer already treats as impossible', () => {
    expect(migration).toMatch(/media_type text not null check \(media_type in \('movie', 'tv'\)\)/);
    expect(migration).toMatch(/media_id integer not null check \(media_id > 0\)/);
    expect(migration).toMatch(/position_seconds integer not null check \(position_seconds >= 0\)/);
    /* Null is allowed and zero is not: a provider that never reported a length
       must not be recorded as a zero-length title. */
    expect(migration).toMatch(/duration_seconds integer check \(duration_seconds is null or duration_seconds > 0\)/);
  });

  it('cleans up after a deleted account', () => {
    expect(migration).toMatch(/references auth\.users\(id\) on delete cascade/);
  });
});
