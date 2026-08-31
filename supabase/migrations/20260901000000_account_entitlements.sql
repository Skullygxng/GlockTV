-- GlockTV account entitlements.
--
-- The row that decides whether an account is Premium and whether it sees ads.
-- It is deliberately NOT part of public.profiles: that table carries a
-- "for all to authenticated" policy so people can rename themselves, and a
-- tier column living there would be editable from any browser console.
--
-- Authority to WRITE this table is reserved for trusted server-side callers
-- (the service role, and later a verified billing webhook running as it).
-- Nothing here grants the browser a write path, and no security definer
-- function is added that would lend one:
--
--   * RLS is on, and the only policy is a select of the caller's own row.
--   * The table-level grant is select only, so even a future policy mistake
--     cannot by itself hand out insert/update/delete.
--
-- Rollback: drop policy, then drop table. No existing table is altered and no
-- Friends data is touched, so reverting removes entitlements only - every
-- account resolves to free/ads-on again, which is the same fail-closed default
-- that applies today to an account with no row.

create table if not exists public.account_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'premium')),
  ads_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.account_entitlements enable row level security;

revoke all on public.account_entitlements from public, anon, authenticated;
grant select on public.account_entitlements to authenticated;

drop policy if exists "Accounts read their own entitlement" on public.account_entitlements;
create policy "Accounts read their own entitlement"
on public.account_entitlements for select to authenticated
using (user_id = (select auth.uid()));
