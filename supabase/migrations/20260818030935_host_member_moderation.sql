alter table public.room_members
add column if not exists is_muted boolean not null default false;

create table if not exists public.room_bans (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

alter table public.room_bans enable row level security;
revoke all on public.room_bans from public, anon, authenticated;

create or replace function public.join_watch_room(p_code text, p_nickname text)
returns setof public.watch_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_nickname := btrim(p_nickname);
  if char_length(p_nickname) not between 1 and 24 then raise exception 'Nickname must be 1 to 24 characters'; end if;

  select * into v_room from public.watch_rooms
  where code = upper(btrim(p_code)) and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;

  if exists (
    select 1 from public.room_bans
    where room_id = v_room.id and user_id = auth.uid()
  ) then
    raise exception 'The host removed you from this room';
  end if;

  insert into public.room_members (room_id, user_id, nickname)
  values (v_room.id, auth.uid(), p_nickname)
  on conflict (room_id, user_id) do update set nickname = excluded.nickname;

  return next v_room;
end;
$$;

create or replace function public.moderate_watch_room_member(
  p_room_id uuid,
  p_target_user_id uuid,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_action not in ('mute', 'unmute', 'kick') then raise exception 'Invalid moderation action'; end if;
  if p_target_user_id = auth.uid() then raise exception 'Hosts cannot moderate themselves'; end if;

  if not exists (
    select 1
    from public.watch_rooms r
    join public.room_members host_member
      on host_member.room_id = r.id and host_member.user_id = auth.uid()
    where r.id = p_room_id
      and r.host_id = auth.uid()
      and not r.is_official
      and r.expires_at > now()
  ) then
    raise exception 'Only the active room host can moderate members';
  end if;

  if not exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = p_target_user_id
  ) then
    raise exception 'That person is no longer in the room';
  end if;

  if p_action = 'kick' then
    insert into public.room_bans (room_id, user_id)
    values (p_room_id, p_target_user_id)
    on conflict (room_id, user_id) do nothing;

    delete from public.room_members
    where room_id = p_room_id and user_id = p_target_user_id;
  else
    update public.room_members
    set is_muted = (p_action = 'mute')
    where room_id = p_room_id and user_id = p_target_user_id;
  end if;
end;
$$;

create or replace function public.send_watch_room_message(p_room_id uuid, p_body text)
returns setof public.chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members%rowtype;
  v_message public.chat_messages%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_member
  from public.room_members
  where room_id = p_room_id and user_id = auth.uid();

  if not found then raise exception 'You are no longer in this room'; end if;
  if v_member.is_muted then raise exception 'The host muted your chat'; end if;

  p_body := btrim(p_body);
  if char_length(p_body) not between 1 and 500 then raise exception 'Message must be 1 to 500 characters'; end if;

  insert into public.chat_messages (room_id, user_id, nickname, body)
  values (p_room_id, auth.uid(), v_member.nickname, p_body)
  returning * into v_message;

  return next v_message;
end;
$$;

create or replace function public.watch_room_membership_status(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then 'removed'
    when exists (
      select 1 from public.room_bans
      where room_id = p_room_id and user_id = auth.uid()
    ) then 'removed'
    when exists (
      select 1 from public.room_members
      where room_id = p_room_id and user_id = auth.uid() and is_muted
    ) then 'muted'
    when exists (
      select 1 from public.room_members
      where room_id = p_room_id and user_id = auth.uid()
    ) then 'active'
    else 'removed'
  end;
$$;

drop policy if exists "Members can send as themselves" on public.chat_messages;
revoke insert on public.chat_messages from authenticated;

revoke all on function public.moderate_watch_room_member(uuid, uuid, text) from public, anon;
revoke all on function public.send_watch_room_message(uuid, text) from public, anon;
revoke all on function public.watch_room_membership_status(uuid) from public, anon;
grant execute on function public.moderate_watch_room_member(uuid, uuid, text) to authenticated;
grant execute on function public.send_watch_room_message(uuid, text) to authenticated;
grant execute on function public.watch_room_membership_status(uuid) to authenticated;
