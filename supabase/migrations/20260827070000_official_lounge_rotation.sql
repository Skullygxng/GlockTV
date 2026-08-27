create or replace function public.apply_official_lounge_title(
  p_room_id uuid,
  p_title_id bigint,
  p_media_type text,
  p_title_name text,
  p_backdrop_path text default null,
  p_duration_seconds integer default null
)
returns setof public.watch_rooms
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

  p_title_name := btrim(p_title_name);
  if char_length(p_title_name) not between 1 and 160 then
    raise exception 'Title is invalid';
  end if;
  if p_media_type not in ('movie', 'tv') then
    raise exception 'Media type is invalid';
  end if;

  if not exists (
    select 1
    from public.room_members m
    where m.room_id = p_room_id
      and m.user_id = auth.uid()
  ) then
    raise exception 'Join the lounge before changing the title';
  end if;

  select * into v_room
  from public.watch_rooms
  where id = p_room_id
    and is_official
    and is_public
    and expires_at > now();

  if not found then
    raise exception 'Only the public lounge can rotate titles this way';
  end if;

  if v_room.playback_updated_at > now() - interval '90 seconds'
     and v_room.title_id = p_title_id
     and v_room.media_type = p_media_type then
    return next v_room;
    return;
  end if;

  if v_room.playback_updated_at > now() - interval '90 seconds'
     and v_room.title_id <> p_title_id then
    raise exception 'The lounge just changed titles. Vote on the next one.';
  end if;

  update public.watch_rooms
  set title_id = p_title_id,
      media_type = p_media_type,
      title_name = p_title_name,
      backdrop_path = p_backdrop_path,
      duration_seconds = p_duration_seconds,
      season_number = 1,
      episode_number = 1,
      playback_state = 'playing',
      playback_position = 0,
      playback_updated_at = now()
  where id = p_room_id
  returning * into v_room;

  delete from public.chat_messages where room_id = p_room_id;
  return next v_room;
end;
$$;

revoke all on function public.apply_official_lounge_title(uuid, bigint, text, text, text, integer) from public, anon;
grant execute on function public.apply_official_lounge_title(uuid, bigint, text, text, text, integer) to authenticated;
