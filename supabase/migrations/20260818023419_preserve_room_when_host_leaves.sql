-- Leaving removes only the caller's audience membership. Private rooms remain
-- available until their existing expiry so hosts can safely resume them.
create or replace function public.leave_watch_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  delete from public.room_members
  where room_id = p_room_id
    and user_id = auth.uid();
end;
$$;

revoke all on function public.leave_watch_room(uuid) from public, anon;
grant execute on function public.leave_watch_room(uuid) to authenticated;
