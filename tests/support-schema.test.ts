import { describe, expect, it } from 'vitest';
import migration from '../supabase/migrations/20260903210000_support_tickets.sql?raw';
import supportService from '../src/lib/support.ts?raw';
import supportPanel from '../src/components/SupportPanel.tsx?raw';

/*
 * The support boundaries, read from the migration.
 *
 * Source-level, and that matters: these catch a policy or grant that was never
 * written, not one the project has since been changed by hand. Every property
 * below is one that would let an ordinary account answer its own ticket as
 * staff, close it, or read somebody else's - so they are worth asserting even
 * against a file, and they are not a substitute for running it.
 */
const statements = migration.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function grantsFor(table: string): string[] {
  return statements
    .split('\n')
    .filter((line) => line.trim().startsWith('grant ') && line.includes(table));
}

describe('staff cannot be granted from a browser', () => {
  it('gives the browser roles no access to the staff table at all', () => {
    /*
     * The strongest form of the guarantee: with no grant, PostgREST refuses the
     * relation before RLS is consulted, so there is no policy on this table
     * whose mistake could matter to a browser.
     */
    expect(statements).toMatch(/revoke all on public\.staff_members from public, anon, authenticated/);
    expect(grantsFor('public.staff_members')).toEqual([]);
  });

  it('still turns row level security on, rather than relying on the grant alone', () => {
    expect(statements).toMatch(/alter table public\.staff_members enable row level security/);
  });

  it('adds no function that could make somebody staff', () => {
    /* A setStaff() reachable from the browser is the escalation this whole
       design exists to prevent. */
    expect(statements).not.toMatch(/insert into public\.staff_members/i);
    const functions = [...statements.matchAll(/create or replace function (public\.[a-z_]+)/g)].map((m) => m[1]);
    expect(functions.sort()).toEqual([
      'public.is_support_staff',
      'public.set_support_message_author_role',
      'public.touch_support_ticket',
    ]);
  });

  it('lets a caller ask only about themselves', () => {
    const fn = statements.slice(
      statements.indexOf('create or replace function public.is_support_staff'),
      statements.indexOf('revoke all on function public.is_support_staff'),
    );
    /* Scoped to auth.uid(), so it cannot enumerate staff or test anybody else. */
    expect(fn).toMatch(/s\.user_id = \(select auth\.uid\(\)\)/);
    expect(fn).toMatch(/returns boolean/);
    /* Pinned, so a caller-controlled search_path cannot resolve the staff table
       to one they created. */
    expect(fn).toMatch(/set search_path = ''/);
  });

  it('pins search_path on every security definer function', () => {
    const definers = statements.split('create or replace function').filter((block) => /security definer/.test(block));
    expect(definers.length).toBe(3);
    for (const block of definers) {
      expect(block).toMatch(/set search_path = ''/);
    }
  });
});

describe('status is not writable from a browser', () => {
  it('grants no update on tickets, so no policy mistake can become self-service resolved', () => {
    const grants = grantsFor('public.support_tickets');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/grant select, insert on public\.support_tickets to authenticated;/);
    expect(grants[0]).not.toMatch(/\bupdate\b/);
    expect(grants[0]).not.toMatch(/\bdelete\b/);
  });

  it('has no update policy on tickets to go with it', () => {
    const ticketPolicies = [...statements.matchAll(/create policy "([^"]+)"\s*\non public\.support_tickets for (\w+)/g)]
      .map((match) => match[2]);
    expect(ticketPolicies.sort()).toEqual(['insert', 'select']);
  });

  it('refuses a ticket that arrives already resolved', () => {
    const insert = statements.slice(statements.indexOf('create policy "Customers open their own tickets"'));
    expect(insert).toMatch(/status = 'open'/);
  });

  it('constrains status to the values the client knows', () => {
    expect(statements).toMatch(/status text not null default 'open' check \(status in \('open', 'pending', 'resolved', 'closed'\)\)/);
  });
});

describe('a customer cannot speak as staff', () => {
  it('derives the author role in a trigger rather than trusting the payload', () => {
    /*
     * A policy could express the same rule, but a trigger holds regardless of
     * which policy, grant or future path performs the insert - and it
     * overwrites a payload that claims 'staff' rather than rejecting it.
     */
    const fn = statements.slice(
      statements.indexOf('create or replace function public.set_support_message_author_role'),
      statements.indexOf('drop trigger if exists support_messages_author_role'),
    );
    expect(fn).toMatch(/new\.author_role := case when public\.is_support_staff\(\) then 'staff' else 'customer' end/);
    expect(fn).toMatch(/new\.author_id := \(select auth\.uid\(\)\)/);
    expect(statements).toMatch(/before insert on public\.support_messages/);
  });

  it('never sends an author role from the client', () => {
    expect(supportService).not.toMatch(/author_role\s*:/);
    expect(supportPanel).not.toMatch(/author_role/);
  });

  it('keeps a transcript neither side can rewrite', () => {
    const grants = grantsFor('public.support_messages');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/grant select, insert on public\.support_messages to authenticated;/);
    expect(grants[0]).not.toMatch(/\b(update|delete)\b/);
  });
});

describe('one customer cannot reach another', () => {
  it('scopes every ticket policy to the caller or to staff', () => {
    const policies = [...statements.matchAll(/create policy "[^"]+"\s*\non public\.support_(tickets|messages)[\s\S]*?;/g)]
      .map((match) => match[0]);
    expect(policies.length).toBe(4);
    for (const policy of policies) {
      expect(policy).toMatch(/auth\.uid\(\)/);
    }
  });

  it('reaches messages only through a ticket the caller may see', () => {
    const messageSelect = statements.slice(
      statements.indexOf('create policy "Participants read the thread"'),
      statements.indexOf('drop policy if exists "Participants reply to the thread"'),
    );
    expect(messageSelect).toMatch(/from public\.support_tickets t/);
    expect(messageSelect).toMatch(/t\.user_id = \(select auth\.uid\(\)\) or public\.is_support_staff\(\)/);
  });

  it('checks the same on the way in as on the way out', () => {
    const messageInsert = statements.slice(statements.indexOf('create policy "Participants reply to the thread"'));
    expect(messageInsert).toMatch(/author_id = \(select auth\.uid\(\)\)/);
    expect(messageInsert).toMatch(/from public\.support_tickets t/);
  });

  it('refuses an anonymous session, where the reply would have nowhere to go', () => {
    expect(statements).toMatch(/auth\.jwt\(\) ->> 'is_anonymous'/);
  });
});

describe('the schema fits how it is read', () => {
  it('indexes both the customer view and the staff queue', () => {
    expect(statements).toMatch(/on public\.support_tickets \(user_id, created_at desc\)/);
    expect(statements).toMatch(/on public\.support_tickets \(status, updated_at desc\)/);
    expect(statements).toMatch(/on public\.support_messages \(ticket_id, created_at\)/);
  });

  it('bounds what can be written into it', () => {
    expect(statements).toMatch(/subject text not null check \(length\(btrim\(subject\)\) between 1 and 140\)/);
    expect(statements).toMatch(/body text not null check \(length\(btrim\(body\)\) between 1 and 4000\)/);
    expect(statements).toMatch(/category text not null check \(category in \(/);
  });

  it('is re-runnable', () => {
    expect((statements.match(/create table if not exists/g) ?? [])).toHaveLength(3);
    expect((statements.match(/drop policy if exists/g) ?? [])).toHaveLength(4);
    expect((statements.match(/drop trigger if exists/g) ?? [])).toHaveLength(2);
  });

  it('touches nothing that already exists', () => {
    for (const table of ['account_entitlements', 'billing_subscriptions', 'watch_rooms', 'room_members', 'watch_progress']) {
      expect(statements).not.toContain(table);
    }
    expect(statements).not.toMatch(/alter table public\.(?!support_|staff_)/);
  });
});
