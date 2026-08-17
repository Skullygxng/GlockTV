alter table public.watch_rooms alter column host_id drop not null;
alter table public.watch_rooms alter column trailer_key drop not null;
alter table public.watch_rooms add column if not exists season_number integer not null default 1 check (season_number > 0);
alter table public.watch_rooms add column if not exists episode_number integer not null default 1 check (episode_number > 0);
alter table public.watch_rooms add column if not exists backdrop_path text;
alter table public.watch_rooms add column if not exists duration_seconds integer check (duration_seconds is null or duration_seconds > 0);
alter table public.watch_rooms add column if not exists is_public boolean not null default false;
alter table public.watch_rooms add column if not exists is_official boolean not null default false;
create index if not exists watch_rooms_public_idx on public.watch_rooms(is_public, expires_at) where is_public;

drop function if exists public.create_watch_room(text, bigint, text, text, text);
create function public.create_watch_room(p_nickname text, p_title_id bigint, p_media_type text, p_title_name text, p_backdrop_path text default null, p_duration_seconds integer default null)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_code text; v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_nickname := btrim(p_nickname); p_title_name := btrim(p_title_name);
  if char_length(p_nickname) not between 1 and 24 then raise exception 'Nickname must be 1 to 24 characters'; end if;
  if char_length(p_title_name) not between 1 and 160 then raise exception 'Title is invalid'; end if;
  if p_media_type not in ('movie', 'tv') then raise exception 'Media type is invalid'; end if;
  if p_duration_seconds is not null and p_duration_seconds <= 0 then raise exception 'Duration is invalid'; end if;
  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1), '') into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.watch_rooms where code = v_code);
  end loop;
  insert into public.watch_rooms (code, host_id, title_id, media_type, title_name, backdrop_path, duration_seconds)
  values (v_code, auth.uid(), p_title_id, p_media_type, p_title_name, nullif(p_backdrop_path, ''), p_duration_seconds) returning * into v_room;
  insert into public.room_members (room_id, user_id, nickname) values (v_room.id, auth.uid(), p_nickname);
  return next v_room;
end; $$;

drop function if exists public.update_watch_room_title(uuid, bigint, text, text, text);
create function public.update_watch_room_title(p_room_id uuid, p_title_id bigint, p_media_type text, p_title_name text, p_backdrop_path text default null, p_duration_seconds integer default null)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_title_name := btrim(p_title_name);
  if char_length(p_title_name) not between 1 and 160 then raise exception 'Title is invalid'; end if;
  if p_media_type not in ('movie', 'tv') then raise exception 'Media type is invalid'; end if;
  if p_duration_seconds is not null and p_duration_seconds <= 0 then raise exception 'Duration is invalid'; end if;
  update public.watch_rooms set title_id = p_title_id, media_type = p_media_type, title_name = p_title_name,
    backdrop_path = nullif(p_backdrop_path, ''), duration_seconds = p_duration_seconds, season_number = 1, episode_number = 1,
    playback_state = 'paused', playback_position = 0, playback_updated_at = now()
  where id = p_room_id and host_id = auth.uid() and public.is_room_member(id) and not is_official and expires_at > now() returning * into v_room;
  if not found then raise exception 'Only the room host can change the title'; end if;
  return next v_room;
end; $$;

create or replace function public.update_watch_room_episode(p_room_id uuid, p_season_number integer, p_episode_number integer)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_season_number <= 0 or p_episode_number <= 0 then raise exception 'Episode is invalid'; end if;
  update public.watch_rooms set season_number = p_season_number, episode_number = p_episode_number,
    playback_state = 'paused', playback_position = 0, playback_updated_at = now()
  where id = p_room_id and host_id = auth.uid() and public.is_room_member(id) and media_type = 'tv' and not is_official and expires_at > now() returning * into v_room;
  if not found then raise exception 'Only the room host can change the episode'; end if;
  return next v_room;
end; $$;

create or replace function public.leave_watch_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official) then
    delete from public.watch_rooms where id = p_room_id;
  else
    delete from public.room_members where room_id = p_room_id and user_id = auth.uid();
  end if;
end; $$;

create or replace function public.list_public_watch_rooms()
returns table (id uuid, code text, host_id uuid, title_id bigint, media_type text, title_name text,
  playback_state text, playback_position double precision, playback_updated_at timestamptz,
  season_number integer, episode_number integer, backdrop_path text, duration_seconds integer,
  is_public boolean, is_official boolean, audience_count bigint)
language sql stable security definer set search_path = '' as $$
  select r.id, r.code, r.host_id, r.title_id, r.media_type, r.title_name, r.playback_state, r.playback_position,
    r.playback_updated_at, r.season_number, r.episode_number, r.backdrop_path, r.duration_seconds,
    r.is_public, r.is_official, count(m.user_id)::bigint
  from public.watch_rooms r left join public.room_members m on m.room_id = r.id
  where r.is_public and r.expires_at > now()
  group by r.id order by r.is_official desc, count(m.user_id) desc, r.created_at limit 12;
$$;

insert into public.watch_rooms (code, host_id, title_id, media_type, title_name, trailer_key, playback_state,
  playback_position, playback_updated_at, season_number, episode_number, backdrop_path, duration_seconds, is_public, is_official, expires_at)
values ('GLOCK1', null, 27205, 'movie', 'Inception', null, 'playing', 0, now(), 1, 1,
  '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg', 8880, true, true, 'infinity'::timestamptz)
on conflict (code) do update set host_id = null, title_id = excluded.title_id, media_type = excluded.media_type,
  title_name = excluded.title_name, trailer_key = null, playback_state = 'playing', playback_position = 0,
  playback_updated_at = now(), season_number = 1, episode_number = 1, backdrop_path = excluded.backdrop_path,
  duration_seconds = excluded.duration_seconds, is_public = true, is_official = true, expires_at = 'infinity'::timestamptz;

revoke all on function public.create_watch_room(text, bigint, text, text, text, integer) from public, anon;
revoke all on function public.update_watch_room_title(uuid, bigint, text, text, text, integer) from public, anon;
revoke all on function public.update_watch_room_episode(uuid, integer, integer) from public, anon;
revoke all on function public.list_public_watch_rooms() from public;
grant execute on function public.create_watch_room(text, bigint, text, text, text, integer) to authenticated;
grant execute on function public.update_watch_room_title(uuid, bigint, text, text, text, integer) to authenticated;
grant execute on function public.update_watch_room_episode(uuid, integer, integer) to authenticated;
grant execute on function public.list_public_watch_rooms() to anon, authenticated;
