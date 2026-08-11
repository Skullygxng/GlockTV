create or replace function public.update_watch_room_title(
  p_room_id uuid,
  p_title_id bigint,
  p_media_type text,
  p_title_name text,
  p_trailer_key text
)
returns setof public.watch_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_title_name := btrim(p_title_name);
  if char_length(p_title_name) not between 1 and 160 then raise exception 'Title is invalid'; end if;
  if p_media_type not in ('movie', 'tv') then raise exception 'Media type is invalid'; end if;
  if p_trailer_key !~ '^[A-Za-z0-9_-]{5,32}$' then raise exception 'Trailer is invalid'; end if;

  update public.watch_rooms
  set title_id = p_title_id,
      media_type = p_media_type,
      title_name = p_title_name,
      trailer_key = p_trailer_key,
      playback_state = 'paused',
      playback_position = 0,
      playback_updated_at = now()
  where id = p_room_id
    and host_id = auth.uid()
    and public.is_room_member(id)
    and expires_at > now()
  returning * into v_room;

  if not found then raise exception 'Only the room host can change the title'; end if;
  return next v_room;
end;
$$;

revoke all on function public.update_watch_room_title(uuid, bigint, text, text, text) from public, anon;
grant execute on function public.update_watch_room_title(uuid, bigint, text, text, text) to authenticated;
