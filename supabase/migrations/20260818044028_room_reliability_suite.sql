alter table public.watch_rooms
  add column if not exists server_id text not null default 'cinesrc',
  add column if not exists is_locked boolean not null default false,
  add column if not exists slow_mode_seconds integer not null default 0
    check (slow_mode_seconds in (0, 3, 5, 10, 15, 30));

alter table public.room_members
  add column if not exists is_cohost boolean not null default false,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists sync_status text not null default 'connecting'
    check (sync_status in ('connecting', 'synced', 'drifting', 'limited')),
  add column if not exists sync_offset_seconds double precision,
  add column if not exists server_id text;

alter table public.room_bans
  add column if not exists nickname text not null default 'Removed viewer';

create index if not exists room_members_room_last_seen_idx
on public.room_members(room_id, last_seen_at desc);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 24),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_blocks (
  blocker_user_id uuid not null references auth.users(id) on delete cascade,
  blocked_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

create table if not exists public.message_reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete set null,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('spam', 'abuse', 'spoiler', 'other')),
  body_snapshot text not null,
  created_at timestamptz not null default now(),
  unique (message_id, reporter_user_id)
);

create index if not exists user_blocks_blocked_user_idx on public.user_blocks(blocked_user_id);
create index if not exists message_reports_room_created_idx on public.message_reports(room_id, created_at desc);
create index if not exists message_reports_reported_user_idx on public.message_reports(reported_user_id);

alter table public.profiles enable row level security;
alter table public.user_blocks enable row level security;
alter table public.message_reports enable row level security;

revoke all on public.user_blocks, public.message_reports from public, anon, authenticated;
revoke all on public.profiles from public, anon;
grant select, insert, update on public.profiles to authenticated;

drop policy if exists "Users manage their own profile" on public.profiles;
create policy "Users manage their own profile"
on public.profiles for all to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create or replace function public.save_watch_profile(p_display_name text)
returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare v_profile public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_display_name := btrim(p_display_name);
  if char_length(p_display_name) not between 1 and 24 then raise exception 'Display name must be 1 to 24 characters'; end if;
  insert into public.profiles (id, display_name)
  values (auth.uid(), p_display_name)
  on conflict (id) do update set display_name = excluded.display_name, updated_at = now()
  returning * into v_profile;
  return v_profile;
end; $$;

create or replace function public.get_active_watch_room_members(p_room_id uuid)
returns table (
  user_id uuid, nickname text, joined_at timestamptz, is_muted boolean,
  is_cohost boolean, last_seen_at timestamptz, sync_status text,
  sync_offset_seconds double precision, server_id text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then
    raise exception 'Room membership required';
  end if;
  return query
    select m.user_id, m.nickname, m.joined_at, m.is_muted, m.is_cohost,
      m.last_seen_at, m.sync_status, m.sync_offset_seconds, m.server_id
    from public.room_members m
    where m.room_id = p_room_id
      and m.last_seen_at > now() - interval '75 seconds'
    order by m.joined_at;
end; $$;

create or replace function public.heartbeat_watch_room(
  p_room_id uuid,
  p_sync_status text default 'connecting',
  p_sync_offset_seconds double precision default null,
  p_server_id text default null
)
returns setof public.watch_rooms
language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype; v_next_host uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_sync_status not in ('connecting', 'synced', 'drifting', 'limited') then raise exception 'Invalid sync status'; end if;
  if p_sync_offset_seconds is not null and abs(p_sync_offset_seconds) > 86400 then raise exception 'Invalid sync offset'; end if;
  if p_server_id is not null and p_server_id !~ '^[a-z0-9_-]{1,32}$' then raise exception 'Invalid server'; end if;

  update public.room_members
  set last_seen_at = now(), sync_status = p_sync_status,
      sync_offset_seconds = p_sync_offset_seconds, server_id = nullif(p_server_id, '')
  where room_id = p_room_id and user_id = auth.uid();
  if not found then raise exception 'You are no longer in this room'; end if;

  select * into v_room from public.watch_rooms where id = p_room_id and expires_at > now() for update;
  if not found then raise exception 'Room not found or expired'; end if;

  if not v_room.is_official and (
    v_room.host_id is null or not exists (
      select 1 from public.room_members hm
      where hm.room_id = p_room_id and hm.user_id = v_room.host_id
        and hm.last_seen_at > now() - interval '60 seconds'
    )
  ) then
    select m.user_id into v_next_host
    from public.room_members m
    where m.room_id = p_room_id and m.last_seen_at > now() - interval '60 seconds'
    order by m.is_cohost desc, m.joined_at
    limit 1;
    if v_next_host is not null then
      update public.watch_rooms set host_id = v_next_host where id = p_room_id returning * into v_room;
      update public.room_members set is_cohost = false where room_id = p_room_id and user_id = v_next_host;
    end if;
  end if;
  return next v_room;
end; $$;

create or replace function public.set_watch_room_cohost(p_room_id uuid, p_target_user_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_target_user_id = auth.uid() then raise exception 'The host is already in control'; end if;
  if not exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official and expires_at > now()) then
    raise exception 'Only the active room host can choose a co-host';
  end if;
  update public.room_members set is_cohost = p_enabled
  where room_id = p_room_id and user_id = p_target_user_id and last_seen_at > now() - interval '75 seconds';
  if not found then raise exception 'That person is no longer active in the room'; end if;
end; $$;

create or replace function public.transfer_watch_room_host(p_room_id uuid, p_target_user_id uuid)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_target_user_id = auth.uid() then raise exception 'You already host this room'; end if;
  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_target_user_id and last_seen_at > now() - interval '75 seconds') then
    raise exception 'That person is no longer active in the room';
  end if;
  update public.watch_rooms set host_id = p_target_user_id
  where id = p_room_id and host_id = auth.uid() and not is_official and expires_at > now()
  returning * into v_room;
  if not found then raise exception 'Only the active room host can transfer control'; end if;
  update public.room_members set is_cohost = true where room_id = p_room_id and user_id = auth.uid();
  update public.room_members set is_cohost = false where room_id = p_room_id and user_id = p_target_user_id;
  return next v_room;
end; $$;

create or replace function public.set_watch_room_server(p_room_id uuid, p_server_id text)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_server_id := lower(btrim(p_server_id));
  if p_server_id !~ '^[a-z0-9_-]{1,32}$' then raise exception 'Invalid server'; end if;
  update public.watch_rooms set server_id = p_server_id
  where id = p_room_id and host_id = auth.uid() and not is_official and expires_at > now()
  returning * into v_room;
  if not found then raise exception 'Only the active room host can change the room server'; end if;
  return next v_room;
end; $$;

create or replace function public.set_watch_room_controls(
  p_room_id uuid, p_is_locked boolean, p_slow_mode_seconds integer
)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_slow_mode_seconds not in (0, 3, 5, 10, 15, 30) then raise exception 'Invalid slow mode'; end if;
  update public.watch_rooms set is_locked = p_is_locked, slow_mode_seconds = p_slow_mode_seconds
  where id = p_room_id and host_id = auth.uid() and not is_official and expires_at > now()
  returning * into v_room;
  if not found then raise exception 'Only the active room host can change room controls'; end if;
  return next v_room;
end; $$;

create or replace function public.join_watch_room(p_code text, p_nickname text)
returns setof public.watch_rooms language plpgsql security definer set search_path = '' as $$
declare v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_nickname := btrim(p_nickname);
  if char_length(p_nickname) not between 1 and 24 then raise exception 'Nickname must be 1 to 24 characters'; end if;
  select * into v_room from public.watch_rooms where code = upper(btrim(p_code)) and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;
  if exists (select 1 from public.room_bans where room_id = v_room.id and user_id = auth.uid()) then
    raise exception 'The host removed you from this room';
  end if;
  if v_room.is_locked and not exists (select 1 from public.room_members where room_id = v_room.id and user_id = auth.uid()) then
    raise exception 'This room is locked by the host';
  end if;
  insert into public.room_members (room_id, user_id, nickname, last_seen_at)
  values (v_room.id, auth.uid(), p_nickname, now())
  on conflict (room_id, user_id) do update set nickname = excluded.nickname, last_seen_at = now();
  perform public.save_watch_profile(p_nickname);
  return next v_room;
end; $$;

create or replace function public.leave_watch_room(p_room_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_next_host uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official) then
    select m.user_id into v_next_host from public.room_members m
    where m.room_id = p_room_id and m.user_id <> auth.uid() and m.last_seen_at > now() - interval '75 seconds'
    order by m.is_cohost desc, m.joined_at limit 1;
    if v_next_host is null then
      delete from public.watch_rooms where id = p_room_id;
      return;
    end if;
    update public.watch_rooms set host_id = v_next_host where id = p_room_id;
    update public.room_members set is_cohost = false where room_id = p_room_id and user_id = v_next_host;
  end if;
  delete from public.room_members where room_id = p_room_id and user_id = auth.uid();
end; $$;

create or replace function public.moderate_watch_room_member(p_room_id uuid, p_target_user_id uuid, p_action text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_nickname text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_action not in ('mute', 'unmute', 'kick') then raise exception 'Invalid moderation action'; end if;
  if p_target_user_id = auth.uid() then raise exception 'Hosts cannot moderate themselves'; end if;
  if not exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official and expires_at > now()) then
    raise exception 'Only the active room host can moderate members';
  end if;
  select nickname into v_nickname from public.room_members where room_id = p_room_id and user_id = p_target_user_id;
  if not found then raise exception 'That person is no longer in the room'; end if;
  if p_action = 'kick' then
    insert into public.room_bans (room_id, user_id, nickname) values (p_room_id, p_target_user_id, v_nickname)
    on conflict (room_id, user_id) do update set nickname = excluded.nickname, created_at = now();
    delete from public.room_members where room_id = p_room_id and user_id = p_target_user_id;
  else
    update public.room_members set is_muted = (p_action = 'mute') where room_id = p_room_id and user_id = p_target_user_id;
  end if;
end; $$;

create or replace function public.list_watch_room_bans(p_room_id uuid)
returns table (user_id uuid, nickname text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official) then
    raise exception 'Only the room host can view removed people';
  end if;
  return query select b.user_id, b.nickname, b.created_at from public.room_bans b where b.room_id = p_room_id order by b.created_at desc;
end; $$;

create or replace function public.unban_watch_room_member(p_room_id uuid, p_target_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official) then
    raise exception 'Only the room host can allow someone back';
  end if;
  delete from public.room_bans where room_id = p_room_id and user_id = p_target_user_id;
end; $$;

create or replace function public.clear_watch_room_chat(p_room_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid() and not is_official) then
    raise exception 'Only the room host can clear chat';
  end if;
  delete from public.chat_messages where room_id = p_room_id;
end; $$;

create or replace function public.set_watch_room_block(p_room_id uuid, p_target_user_id uuid, p_blocked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then raise exception 'Room membership required'; end if;
  if p_target_user_id = auth.uid() then raise exception 'You cannot block yourself'; end if;
  if not exists (select 1 from public.room_members where room_id = p_room_id and user_id = p_target_user_id) then raise exception 'That person is not in this room'; end if;
  if p_blocked then
    insert into public.user_blocks (blocker_user_id, blocked_user_id) values (auth.uid(), p_target_user_id) on conflict do nothing;
  else
    delete from public.user_blocks where blocker_user_id = auth.uid() and blocked_user_id = p_target_user_id;
  end if;
end; $$;

create or replace function public.get_watch_room_blocks()
returns table (blocked_user_id uuid)
language sql stable security definer set search_path = '' as $$
  select b.blocked_user_id from public.user_blocks b where b.blocker_user_id = auth.uid();
$$;

create or replace function public.get_watch_room_messages(p_room_id uuid)
returns setof public.chat_messages
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.is_room_member(p_room_id) then raise exception 'Room membership required'; end if;
  return query select m.* from public.chat_messages m
  where m.room_id = p_room_id
    and not exists (select 1 from public.user_blocks b where b.blocker_user_id = auth.uid() and b.blocked_user_id = m.user_id)
  order by m.created_at desc limit 100;
end; $$;

create or replace function public.report_watch_room_message(p_message_id uuid, p_reason text default 'spam')
returns void language plpgsql security definer set search_path = '' as $$
declare v_message public.chat_messages%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_reason not in ('spam', 'abuse', 'spoiler', 'other') then raise exception 'Invalid report reason'; end if;
  select * into v_message from public.chat_messages where id = p_message_id and public.is_room_member(room_id);
  if not found then raise exception 'Message not found'; end if;
  if v_message.user_id = auth.uid() then raise exception 'You cannot report your own message'; end if;
  if (select count(*) from public.message_reports where reporter_user_id = auth.uid() and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Report limit reached';
  end if;
  insert into public.message_reports (room_id, message_id, reporter_user_id, reported_user_id, reason, body_snapshot)
  values (v_message.room_id, v_message.id, auth.uid(), v_message.user_id, p_reason, v_message.body)
  on conflict (message_id, reporter_user_id) do nothing;
end; $$;

create or replace function public.send_watch_room_message(p_room_id uuid, p_body text)
returns setof public.chat_messages language plpgsql security definer set search_path = '' as $$
declare v_member public.room_members%rowtype; v_room public.watch_rooms%rowtype; v_message public.chat_messages%rowtype; v_last_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_member from public.room_members where room_id = p_room_id and user_id = auth.uid();
  if not found then raise exception 'You are no longer in this room'; end if;
  if v_member.is_muted then raise exception 'The host muted your chat'; end if;
  select * into v_room from public.watch_rooms where id = p_room_id and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;
  p_body := btrim(p_body);
  if char_length(p_body) not between 1 and 500 then raise exception 'Message must be 1 to 500 characters'; end if;
  select max(created_at) into v_last_at from public.chat_messages where room_id = p_room_id and user_id = auth.uid();
  if v_room.slow_mode_seconds > 0 and v_last_at > now() - make_interval(secs => v_room.slow_mode_seconds) then
    raise exception 'Chat slow mode is active';
  end if;
  if (select count(*) from public.chat_messages where room_id = p_room_id and user_id = auth.uid() and created_at > now() - interval '10 seconds') >= (case when v_room.is_public then 3 else 5 end) then
    raise exception 'You are sending messages too quickly';
  end if;
  if exists (select 1 from public.chat_messages where room_id = p_room_id and user_id = auth.uid() and lower(body) = lower(p_body) and created_at > now() - interval '30 seconds') then
    raise exception 'Duplicate message blocked';
  end if;
  if v_room.is_public and p_body ~* '(https?://|www\.)' then raise exception 'Links are disabled in public chat'; end if;
  insert into public.chat_messages (room_id, user_id, nickname, body)
  values (p_room_id, auth.uid(), v_member.nickname, p_body) returning * into v_message;
  update public.room_members set last_seen_at = now() where room_id = p_room_id and user_id = auth.uid();
  return next v_message;
end; $$;

drop function if exists public.list_public_watch_rooms();
create function public.list_public_watch_rooms()
returns table (id uuid, code text, host_id uuid, title_id bigint, media_type text, title_name text,
  playback_state text, playback_position double precision, playback_updated_at timestamptz,
  season_number integer, episode_number integer, backdrop_path text, duration_seconds integer,
  is_public boolean, is_official boolean, server_id text, is_locked boolean, slow_mode_seconds integer,
  audience_count bigint)
language sql stable security definer set search_path = '' as $$
  select r.id, r.code, r.host_id, r.title_id, r.media_type, r.title_name, r.playback_state, r.playback_position,
    r.playback_updated_at, r.season_number, r.episode_number, r.backdrop_path, r.duration_seconds,
    r.is_public, r.is_official, r.server_id, r.is_locked, r.slow_mode_seconds, count(m.user_id)::bigint
  from public.watch_rooms r left join public.room_members m
    on m.room_id = r.id and m.last_seen_at > now() - interval '75 seconds'
  where r.is_public and r.expires_at > now()
  group by r.id order by r.is_official desc, count(m.user_id) desc, r.created_at limit 12;
$$;

revoke all on function public.save_watch_profile(text) from public, anon;
revoke all on function public.get_active_watch_room_members(uuid) from public, anon;
revoke all on function public.heartbeat_watch_room(uuid, text, double precision, text) from public, anon;
revoke all on function public.set_watch_room_cohost(uuid, uuid, boolean) from public, anon;
revoke all on function public.transfer_watch_room_host(uuid, uuid) from public, anon;
revoke all on function public.set_watch_room_server(uuid, text) from public, anon;
revoke all on function public.set_watch_room_controls(uuid, boolean, integer) from public, anon;
revoke all on function public.list_watch_room_bans(uuid) from public, anon;
revoke all on function public.unban_watch_room_member(uuid, uuid) from public, anon;
revoke all on function public.clear_watch_room_chat(uuid) from public, anon;
revoke all on function public.set_watch_room_block(uuid, uuid, boolean) from public, anon;
revoke all on function public.get_watch_room_blocks() from public, anon;
revoke all on function public.get_watch_room_messages(uuid) from public, anon;
revoke all on function public.report_watch_room_message(uuid, text) from public, anon;
revoke all on function public.list_public_watch_rooms() from public;

grant execute on function public.save_watch_profile(text) to authenticated;
grant execute on function public.get_active_watch_room_members(uuid) to authenticated;
grant execute on function public.heartbeat_watch_room(uuid, text, double precision, text) to authenticated;
grant execute on function public.set_watch_room_cohost(uuid, uuid, boolean) to authenticated;
grant execute on function public.transfer_watch_room_host(uuid, uuid) to authenticated;
grant execute on function public.set_watch_room_server(uuid, text) to authenticated;
grant execute on function public.set_watch_room_controls(uuid, boolean, integer) to authenticated;
grant execute on function public.list_watch_room_bans(uuid) to authenticated;
grant execute on function public.unban_watch_room_member(uuid, uuid) to authenticated;
grant execute on function public.clear_watch_room_chat(uuid) to authenticated;
grant execute on function public.set_watch_room_block(uuid, uuid, boolean) to authenticated;
grant execute on function public.get_watch_room_blocks() to authenticated;
grant execute on function public.get_watch_room_messages(uuid) to authenticated;
grant execute on function public.report_watch_room_message(uuid, text) to authenticated;
grant execute on function public.list_public_watch_rooms() to anon, authenticated;
