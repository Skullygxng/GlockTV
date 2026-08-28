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
  v_prefix text := chr(8288) || 'VOTE|';
  v_winner_media_type text;
  v_winner_title_id bigint;
  v_winner_votes integer;
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

  with latest_vote as (
    select distinct on (m.user_id)
      m.user_id,
      m.body,
      m.created_at
    from public.chat_messages m
    where m.room_id = p_room_id
      and m.created_at >= v_room.playback_updated_at
      and left(m.body, char_length(v_prefix)) = v_prefix
    order by m.user_id, m.created_at desc
  ),
  parsed as (
    select
      split_part(substr(body, char_length(v_prefix) + 1), ':', 1) as media_type,
      nullif(split_part(substr(body, char_length(v_prefix) + 1), ':', 2), '')::bigint as title_id,
      created_at
    from latest_vote
  ),
  counted as (
    select
      media_type,
      title_id,
      count(*)::integer as votes,
      max(created_at) as latest_at
    from parsed
    where media_type in ('movie', 'tv')
      and title_id is not null
    group by media_type, title_id
    order by count(*) desc, max(created_at) desc
    limit 1
  )
  select media_type, title_id, votes
  into v_winner_media_type, v_winner_title_id, v_winner_votes
  from counted;

  if v_winner_title_id is null or v_winner_votes < 1 then
    raise exception 'The lounge has no votes to apply';
  end if;

  if p_title_id <> v_winner_title_id or p_media_type <> v_winner_media_type then
    raise exception 'That title is not the current lounge winner';
  end if;

  if v_room.title_id = v_winner_title_id and v_room.media_type = v_winner_media_type then
    return next v_room;
    return;
  end if;

  if v_room.playback_updated_at > now() - interval '90 seconds' then
    raise exception 'The lounge just changed titles. Vote on the next one.';
  end if;

  update public.watch_rooms
  set title_id = v_winner_title_id,
      media_type = v_winner_media_type,
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

  return next v_room;
end;
$$;

revoke all on function public.apply_official_lounge_title(uuid, bigint, text, text, text, integer) from public, anon;
grant execute on function public.apply_official_lounge_title(uuid, bigint, text, text, text, integer) to authenticated;
