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
const statements = migration.replace(/^\s*--.*$/gm, '');

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
    const revokeAt = migration.indexOf('revoke all on public.watch_progress');
    const grantAt = migration.indexOf('grant select, insert, update, delete on public.watch_progress');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(revokeAt);
    expect(migration).toMatch(/revoke all on public\.watch_progress from public, anon, authenticated/);
  });

  it('gives the browser role nothing at all', () => {
    /* anon appears only in the revoke. A signed-out visitor keeps progress on
       the device; there is no row for them to reach. */
    const grants = statements.split('\n').filter((line) => line.trim().startsWith('grant '));
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      /* The grantee only: "public.watch_progress" is the table's schema, not a
         role, and matching the whole statement would fail on every grant. */
      const grantee = grant.slice(grant.lastIndexOf(' to ') + 4);
      expect(grantee).toMatch(/^authenticated\s*;?\s*$/);
    }
  });

  it('scopes every policy to the caller, on both sides of a write', () => {
    const policies = [...migration.matchAll(/create policy "([^"]+)"[\s\S]*?;/g)].map((match) => match[0]);
    expect(policies).toHaveLength(4);

    for (const policy of policies) {
      expect(policy).toMatch(/user_id = \(select auth\.uid\(\)\)/);
      /* An update needs both: using decides which rows may be touched, with
         check decides what they may become. Without the second, a row could be
         handed to another user_id on the way out. */
      if (/for update/.test(policy)) {
        expect(policy).toMatch(/using \(user_id = \(select auth\.uid\(\)\)\)/);
        expect(policy).toMatch(/with check \(user_id = \(select auth\.uid\(\)\)\)/);
      }
      if (/for insert/.test(policy)) {
        expect(policy).toMatch(/with check \(user_id = \(select auth\.uid\(\)\)\)/);
      }
    }
  });

  it('covers all four verbs it grants', () => {
    for (const verb of ['for select', 'for insert', 'for update', 'for delete']) {
      expect(migration).toContain(verb);
    }
  });

  it('is re-runnable', () => {
    expect(migration).toContain('create table if not exists public.watch_progress');
    expect(migration).toContain('create index if not exists watch_progress_user_recent_idx');
    expect((migration.match(/drop policy if exists/g) ?? [])).toHaveLength(4);
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
