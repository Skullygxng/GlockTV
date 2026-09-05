-- Post-migration hardening, from the security and performance advisors run
-- against the live project after the five roadmap migrations were applied.
--
-- Two changes, both narrow. Nothing here alters a policy, a table grant, an
-- entitlement rule or any application behaviour: no row that could be read
-- before becomes unreadable, and no row that could be written before becomes
-- unwritable.
--
-- Rollback: drop the index; re-grant execute to public on the three functions
-- if some future caller genuinely needs to invoke them directly, which would
-- itself be the thing to question.

-- ---------------------------------------------------------------------------
-- 1. Trigger-only functions stop being executable by browser roles
-- ---------------------------------------------------------------------------

/*
 * PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so these
 * three arrived callable by anon and authenticated. Every other function this
 * repository ships revokes that default and grants back deliberately -
 * is_support_staff and apply_billing_provider_state both do - and these three
 * were simply missed.
 *
 * Being accurate about the exposure: all three return trigger, and PostgreSQL
 * refuses to invoke a trigger function directly, so PostgREST cannot turn one
 * into a working RPC today. This is defence in depth against a later edit that
 * changes a return type, not the closing of a live hole. It is still worth
 * doing, because two of them are SECURITY DEFINER and the cost is nothing.
 *
 * Triggers keep firing. EXECUTE on a trigger function is checked when the
 * trigger is created, not each time it fires, and the owner's own privilege is
 * untouched - so set_support_message_author_role still derives author_role on
 * every insert, touch_support_ticket still bumps updated_at, and
 * stamp_watch_progress_updated_at still overwrites updated_at.
 *
 * stamp_watch_progress_updated_at is included although the advisor did not
 * flag it: it is not SECURITY DEFINER, which is why it ranks lower, but it is
 * the same trigger-only shape with the same default grant, and fixing two of
 * three would leave the odd one out to be rediscovered later.
 */

revoke all on function public.set_support_message_author_role() from public, anon, authenticated;
revoke all on function public.touch_support_ticket() from public, anon, authenticated;
revoke all on function public.stamp_watch_progress_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The one foreign key in this schema with nothing to read it by
-- ---------------------------------------------------------------------------

/*
 * Of the eight foreign keys the five migrations declare, seven are already
 * covered: account_entitlements.user_id, billing_customers.user_id,
 * billing_subscriptions.user_id and staff_members.user_id are each their
 * table's primary key, watch_progress.user_id leads its composite primary key,
 * support_tickets.user_id leads support_tickets_user_recent_idx, and
 * support_messages.ticket_id leads support_messages_ticket_idx.
 *
 * support_messages.author_id is the exception. It references auth.users on
 * delete cascade, so deleting an account makes PostgreSQL look for that
 * author's messages with no index to do it by - a sequential scan of the whole
 * transcript table, taken while holding locks, and one that gets worse as
 * support history accumulates rather than better.
 *
 * This is the FK, not the read path. The thread read is by ticket_id and is
 * already served; the insert policy's author_id = auth.uid() check is against
 * the row being written and needs no index at all.
 */

create index if not exists support_messages_author_idx
  on public.support_messages (author_id);
