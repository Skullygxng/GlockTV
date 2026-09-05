-- Recovered from supabase_migrations.schema_migrations.statements on the live
-- project. Naming the primary key constraint directly rather than repeating its
-- column list is what production runs today; the older column-list form is in
-- 20260828044659. Nothing else about the function changed.

create or replace function public.cast_official_lounge_vote(
  p_room_id uuid,
  p_title_id bigint,
  p_media_type text
)
returns table (
  media_type text,
  title_id bigint,
  title_name text,
  backdrop_path text,
  duration_seconds integer,
  vote_count integer,
  is_mine boolean,
  cycle_started_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_media_type not in ('movie', 'tv') then
    raise exception 'Media type is invalid';
  end if;

  select * into v_room
  from public.watch_rooms
  where id = p_room_id
    and is_official
    and is_public
    and expires_at > now();
  if not found then
    raise exception 'Only the public lounge can accept official votes';
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  ) then
    raise exception 'Join the lounge before voting';
  end if;

  perform public.ensure_official_lounge_ballot(p_room_id);

  if not exists (
    select 1 from public.official_lounge_ballot b
    where b.room_id = p_room_id
      and b.cycle_started_at = v_room.playback_updated_at
      and b.title_id = p_title_id
      and b.media_type = p_media_type
  ) then
    raise exception 'That title is not on the current lounge ballot';
  end if;

  insert into public.official_lounge_votes (
    room_id, cycle_started_at, user_id, media_type, title_id
  )
  values (p_room_id, v_room.playback_updated_at, auth.uid(), p_media_type, p_title_id)
  on conflict on constraint official_lounge_votes_pkey
  do update set media_type = excluded.media_type, title_id = excluded.title_id, created_at = now();

  return query select * from public.get_official_lounge_ballot(p_room_id);
end;
$$;

revoke all on function public.cast_official_lounge_vote(uuid, bigint, text) from public, anon;
grant execute on function public.cast_official_lounge_vote(uuid, bigint, text) to authenticated;
