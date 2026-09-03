-- Two server-state corrections to Premium billing.
--
-- 1. Cancellation expiry is now enforced at read time, by the database clock.
--
--    subscriptionStateToEntitlement decides correctly, but it only runs while a
--    webhook is being processed. Once premium was written to
--    account_entitlements, passing current_period_end changed nothing, so a
--    member whose terminal cancellation webhook never arrived stayed Premium
--    indefinitely. account_entitlements_effective recomputes that on every
--    read against now(), so expiry needs no later webhook, no scheduled job and
--    no client clock.
--
-- 2. Applying provider state is now one atomic statement.
--
--    The ordering guard used to be read the stored timestamp, compare it in
--    TypeScript, then write. Two Edge Function invocations could both read,
--    both decide they were newer, and the older one could commit last. The
--    comparison now happens inside a conditional UPDATE, where Postgres holds
--    the row lock, so concurrent writers serialize and the older one no-ops.
--
-- Rollback: drop the function and the view. The base tables and every policy
-- are untouched, so reverting returns to the previous behaviour rather than
-- losing data.

-- ---------------------------------------------------------------------------
-- 1. Effective entitlement
-- ---------------------------------------------------------------------------

-- security_invoker keeps the caller's own RLS in force, so this view shows a
-- member their own row and nobody else's - exactly what the base tables allow.
-- It grants no new visibility; it only corrects the answer.
create or replace view public.account_entitlements_effective
with (security_invoker = on) as
select
  user_id,
  case when premium_expired then 'free' else tier end as tier,
  case when premium_expired then true else ads_enabled end as ads_enabled,
  premium_expired,
  current_period_end,
  cancel_at_period_end
from (
  select
    e.user_id,
    e.tier,
    e.ads_enabled,
    s.current_period_end,
    coalesce(s.cancel_at_period_end, false) as cancel_at_period_end,
    -- A subscription set to cancel will not renew, so its period end is a real
    -- expiry. now() is the database clock; nothing here reads a client's.
    -- A renewing subscription is deliberately not clock-checked: a late
    -- renewal webhook must not read as a lapsed membership.
    (
      e.tier = 'premium'
      and coalesce(s.cancel_at_period_end, false)
      and s.current_period_end is not null
      and s.current_period_end <= now()
    ) as premium_expired
  from public.account_entitlements e
  left join public.billing_subscriptions s on s.user_id = e.user_id
) resolved;

revoke all on public.account_entitlements_effective from public, anon;
grant select on public.account_entitlements_effective to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Atomic provider-state application
-- ---------------------------------------------------------------------------

create or replace function public.apply_billing_provider_state(
  p_user_id uuid,
  p_provider text,
  p_subscription_id text,
  p_customer_id text,
  p_status text,
  p_price_id text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_provider_updated_at timestamptz,
  p_tier text,
  p_ads_enabled boolean,
  p_event_id text,
  p_event_type text,
  p_event_created_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
  v_applied boolean;
begin
  -- Claim the event first. Two deliveries of the same event race here and
  -- exactly one wins the insert, so the loser does no work at all.
  insert into public.billing_webhook_events (provider_event_id, event_type, provider_created_at)
  values (p_event_id, p_event_type, p_event_created_at)
  on conflict (provider_event_id) do nothing;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return 'replay';
  end if;

  -- The ordering comparison lives in the WHERE of the conflict update, so it
  -- is evaluated while this transaction holds the row lock. A concurrent older
  -- event either waits and then fails this test, or inserts first and is
  -- overwritten by the newer one - never the other way round.
  insert into public.billing_subscriptions as existing (
    user_id, provider, provider_subscription_id, provider_customer_id,
    status, price_id, current_period_end, cancel_at_period_end,
    provider_updated_at, updated_at
  )
  values (
    p_user_id, p_provider, p_subscription_id, p_customer_id,
    p_status, p_price_id, p_current_period_end, coalesce(p_cancel_at_period_end, false),
    p_provider_updated_at, now()
  )
  on conflict (user_id) do update set
    provider = excluded.provider,
    provider_subscription_id = excluded.provider_subscription_id,
    provider_customer_id = excluded.provider_customer_id,
    status = excluded.status,
    price_id = excluded.price_id,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    provider_updated_at = excluded.provider_updated_at,
    updated_at = now()
  -- Fail closed on an unknown incoming timestamp. Only a null on the
  -- committed side means "nothing established yet, anything may set it";
  -- a null on the incoming side is an event that cannot prove it is newer,
  -- and letting it through would let an untimestamped payload overwrite
  -- known-good state.
  where existing.provider_updated_at is null
     or (
       excluded.provider_updated_at is not null
       and excluded.provider_updated_at >= existing.provider_updated_at
     );

  get diagnostics v_applied = row_count;
  if v_applied = 0 then
    -- Older than what is committed. The event stays claimed above, so a retry
    -- of it does not reopen this decision.
    return 'stale';
  end if;

  -- Only reached when this event won the ordering test, so the entitlement can
  -- never be written from state the subscription table rejected.
  insert into public.account_entitlements (user_id, tier, ads_enabled, updated_at)
  values (p_user_id, p_tier, p_ads_enabled, now())
  on conflict (user_id) do update set
    tier = excluded.tier,
    ads_enabled = excluded.ads_enabled,
    updated_at = now();

  return 'applied';
end;
$$;

-- Trusted callers only. Exposing this to a browser would be handing out a
-- setPremium() - it writes account_entitlements directly.
revoke all on function public.apply_billing_provider_state(
  uuid, text, text, text, text, text, timestamptz, boolean, timestamptz,
  text, boolean, text, text, timestamptz
) from public, anon, authenticated;

-- Revoking from PUBLIC removes the default execute grant, so the one caller
-- that is meant to run this needs it back explicitly. The webhook reaches it
-- through PostgREST with the service-role key; nothing a browser can present
-- resolves to this role.
grant execute on function public.apply_billing_provider_state(
  uuid, text, text, text, text, text, timestamptz, boolean, timestamptz,
  text, boolean, text, text, timestamptz
) to service_role;
