create policy "Anyone can view official public rooms"
on public.watch_rooms for select to anon, authenticated
using (is_public and is_official and expires_at > now());

create or replace function public.list_public_watch_rooms()
returns table (id uuid, code text, host_id uuid, title_id bigint, media_type text, title_name text,
  playback_state text, playback_position double precision, playback_updated_at timestamptz,
  season_number integer, episode_number integer, backdrop_path text, duration_seconds integer,
  is_public boolean, is_official boolean, audience_count bigint)
language sql stable security invoker set search_path = '' as $$
  select r.id, r.code, r.host_id, r.title_id, r.media_type, r.title_name, r.playback_state, r.playback_position,
    r.playback_updated_at, r.season_number, r.episode_number, r.backdrop_path, r.duration_seconds,
    r.is_public, r.is_official, 1::bigint
  from public.watch_rooms r
  where r.is_public and r.is_official and r.expires_at > now()
  order by r.created_at limit 12;
$$;
