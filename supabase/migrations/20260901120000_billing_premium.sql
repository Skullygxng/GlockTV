-- GlockTV Premium billing.
--
-- Three tables the browser never writes and, with one deliberate exception,
-- never reads. They exist so a verified Stripe webhook can maintain
-- subscription truth server-side; account_entitlements stays the single thing
-- the app reads to decide what a member gets.
--
-- Write authority is the service role, used only by the Edge Functions. As
-- with account_entitlements there are two independent locks on every table:
-- RLS with no write policy, and a table grant that never includes a write. A
-- mistake in either one alone still leaves the browser unable to write.
--
-- No security definer function is added here. One would be a way for an
-- authenticated caller to reach these tables, which is exactly what must not
-- exist.
--
-- Rollback: drop the policy and the three tables. account_entitlements and
-- every Friends table are untouched, so reverting removes billing records
-- only; accounts fall back to the free/ads-on default that a missing
-- entitlement row already produces.

create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  provider_customer_id text unique not null,
  created_at timestamptz not null default now()
);

create table if not exists public.billing_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  provider_subscription_id text unique not null,
  provider_customer_id text not null,
  status text not null,
  price_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  -- When the provider last changed this object. The webhook compares against
  -- it so an event delivered out of order cannot roll newer state backwards.
  provider_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_webhook_events (
  provider_event_id text primary key,
  event_type text not null,
  provider_created_at timestamptz,
  processed_at timestamptz not null default now()
);

create index if not exists billing_customers_provider_customer_idx
on public.billing_customers(provider_customer_id);

create index if not exists billing_subscriptions_customer_idx
on public.billing_subscriptions(provider_customer_id);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_webhook_events enable row level security;

-- No grant at all for two of the three: the browser has no reason to see
-- Stripe customer or event identifiers, and the account panel is served
-- normalized membership state from account_entitlements instead.
revoke all on public.billing_customers from public, anon, authenticated;
revoke all on public.billing_webhook_events from public, anon, authenticated;

-- The one exception. A member may read their own subscription so the account
-- panel can say when a cancelled membership actually ends. It exposes no
-- Stripe identifier the account panel renders, and it is still read-only.
revoke all on public.billing_subscriptions from public, anon, authenticated;
grant select on public.billing_subscriptions to authenticated;

drop policy if exists "Members read their own subscription" on public.billing_subscriptions;
create policy "Members read their own subscription"
on public.billing_subscriptions for select to authenticated
using (user_id = (select auth.uid()));
