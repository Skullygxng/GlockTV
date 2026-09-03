-- GlockTV support tickets.
--
-- Three tables and one function. The whole design turns on a single question:
-- what stops an ordinary account from answering its own ticket as staff, or
-- marking it resolved? The answer is that neither is reachable from the browser
-- at all, rather than being guarded by a check the browser is asked to respect.
--
--   * staff_members has RLS on and NO grant to anon or authenticated. A browser
--     cannot read it, let alone write it. Membership is granted out of band by a
--     trusted caller - the service role or the SQL console - and there is
--     deliberately no RPC that adds a member.
--   * author_role on a message is NOT taken from the client. A trigger derives
--     it from staff membership on the way in, so a payload claiming 'staff' is
--     simply overwritten.
--   * status is not writable by anybody through the browser. authenticated is
--     granted insert and select on tickets and no update at all, so there is no
--     policy mistake that could turn into a self-service "resolved".
--
-- Rollback: drop the policies, the trigger, the function, then the tables in
-- dependency order. Nothing existing is altered, so reverting removes support
-- and leaves accounts, billing, progress and watch parties untouched.

-- ---------------------------------------------------------------------------
-- Staff, and the one thing a browser may ask about it
-- ---------------------------------------------------------------------------

create table if not exists public.staff_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.staff_members enable row level security;

-- No grant follows. That is the point: with none, no policy on this table can
-- matter to a browser, because PostgREST refuses the relation before RLS is
-- ever consulted. Staff are added by a trusted caller only.
revoke all on public.staff_members from public, anon, authenticated;

/*
 * "Am I staff?" - and nothing else.
 *
 * SECURITY DEFINER so it can read a table the caller cannot, and it returns a
 * boolean about the caller alone: it cannot be used to enumerate staff, to test
 * somebody else, or to learn anybody's role. search_path is pinned empty so a
 * caller-controlled search_path cannot resolve public.staff_members to a table
 * they created.
 */
create or replace function public.is_support_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_members s
    where s.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_support_staff() from public, anon;
grant execute on function public.is_support_staff() to authenticated;

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- The product areas GlockTV actually has. A value outside this list is a
  -- client that has drifted from the schema, not a new category.
  category text not null check (category in (
    'account', 'billing', 'playback', 'live_tv', 'ppv', 'friends', 'bug', 'other'
  )),

  subject text not null check (length(btrim(subject)) between 1 and 140),

  -- Server-controlled. See the grants below: authenticated may not update this
  -- table at all, so this column has no browser-reachable write path.
  status text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "My tickets, newest first" is the customer view; "everything open" is the
-- staff view. Both are covered without scanning.
create index if not exists support_tickets_user_recent_idx
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status_idx
  on public.support_tickets (status, updated_at desc);

alter table public.support_tickets enable row level security;

revoke all on public.support_tickets from public, anon, authenticated;
-- Insert and select only. No update, so status cannot be written from a
-- browser even if a future policy were wrong; no delete, so a support history
-- cannot be destroyed by the account it is about.
grant select, insert on public.support_tickets to authenticated;

drop policy if exists "Customers read their own tickets" on public.support_tickets;
create policy "Customers read their own tickets"
on public.support_tickets for select to authenticated
using (user_id = (select auth.uid()) or public.is_support_staff());

drop policy if exists "Customers open their own tickets" on public.support_tickets;
create policy "Customers open their own tickets"
on public.support_tickets for insert to authenticated
with check (
  user_id = (select auth.uid())
  -- A support conversation needs somebody who can be reached and who can come
  -- back to it. An anonymous session that clears its storage loses the ticket
  -- and any reply on it forever, so protecting the account is a precondition
  -- rather than a suggestion the UI makes. Checked here as well as in the UI,
  -- because the UI is not where this is decided.
  and coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  -- Nothing may be opened pre-resolved.
  and status = 'open'
);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,

  -- Derived by the trigger below, never accepted from the client. Kept as a
  -- column rather than resolved at read time so a reply still reads correctly
  -- after somebody stops being staff.
  author_role text not null default 'customer' check (author_role in ('customer', 'staff')),

  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists support_messages_ticket_idx
  on public.support_messages (ticket_id, created_at);

/*
 * Who wrote this is decided here, not by the payload.
 *
 * Without this, a customer could insert author_role = 'staff' on their own
 * ticket and every reader would render it as an official reply. The policy
 * below could express the same rule, but a trigger is the stronger place for
 * it: it holds no matter which policy, grant or future path performs the
 * insert.
 */
create or replace function public.set_support_message_author_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.author_id := (select auth.uid());
  new.author_role := case when public.is_support_staff() then 'staff' else 'customer' end;
  return new;
end;
$$;

drop trigger if exists support_messages_author_role on public.support_messages;
create trigger support_messages_author_role
before insert on public.support_messages
for each row execute function public.set_support_message_author_role();

alter table public.support_messages enable row level security;

revoke all on public.support_messages from public, anon, authenticated;
-- No update and no delete: a support transcript that either side can edit
-- afterwards is not a transcript.
grant select, insert on public.support_messages to authenticated;

/*
 * A replied-to ticket is a newer ticket.
 *
 * Staff triage by updated_at, and authenticated has no update grant on
 * support_tickets on purpose - so the bump happens here, as the definer, where
 * it can touch only this one column on the one ticket being replied to. It is
 * not a general write path: nothing about status, ownership or category is
 * reachable through it.
 */
create or replace function public.touch_support_ticket()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.support_tickets
     set updated_at = now()
   where id = new.ticket_id;
  return null;
end;
$$;

drop trigger if exists support_messages_touch_ticket on public.support_messages;
create trigger support_messages_touch_ticket
after insert on public.support_messages
for each row execute function public.touch_support_ticket();

drop policy if exists "Participants read the thread" on public.support_messages;
create policy "Participants read the thread"
on public.support_messages for select to authenticated
using (
  exists (
    select 1 from public.support_tickets t
    where t.id = ticket_id
      and (t.user_id = (select auth.uid()) or public.is_support_staff())
  )
);

drop policy if exists "Participants reply to the thread" on public.support_messages;
create policy "Participants reply to the thread"
on public.support_messages for insert to authenticated
with check (
  author_id = (select auth.uid())
  and exists (
    select 1 from public.support_tickets t
    where t.id = ticket_id
      and (t.user_id = (select auth.uid()) or public.is_support_staff())
  )
);
