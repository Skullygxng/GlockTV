create extension if not exists pgcrypto with schema extensions;

create table public.watch_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null references auth.users(id) on delete cascade,
  title_id bigint not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  title_name text not null check (char_length(title_name) between 1 and 160),
  trailer_key text not null check (trailer_key ~ '^[A-Za-z0-9_-]{5,32}$'),
  playback_state text not null default 'paused' check (playback_state in ('playing', 'paused')),
  playback_position double precision not null default 0 check (playback_position >= 0),
  playback_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table public.room_members (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 24),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index room_members_user_id_idx on public.room_members(user_id);
create index chat_messages_room_created_at_idx on public.chat_messages(room_id, created_at);
create index watch_rooms_expires_at_idx on public.watch_rooms(expires_at);

alter table public.watch_rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.chat_messages enable row level security;

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room_id and user_id = auth.uid()
  );
$$;

create or replace function public.current_room_nickname(p_room_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nickname from public.room_members
  where room_id = p_room_id and user_id = auth.uid();
$$;

create policy "Members can view their rooms"
on public.watch_rooms for select to authenticated
using (public.is_room_member(id) and expires_at > now());

create policy "Hosts can synchronize playback"
on public.watch_rooms for update to authenticated
using (host_id = auth.uid() and public.is_room_member(id))
with check (host_id = auth.uid() and public.is_room_member(id));

create policy "Members can see the audience"
on public.room_members for select to authenticated
using (public.is_room_member(room_id));

create policy "Members can leave rooms"
on public.room_members for delete to authenticated
using (user_id = auth.uid());

create policy "Members can read room chat"
on public.chat_messages for select to authenticated
using (public.is_room_member(room_id));

create policy "Members can send as themselves"
on public.chat_messages for insert to authenticated
with check (
  user_id = auth.uid()
  and public.is_room_member(room_id)
  and nickname = public.current_room_nickname(room_id)
);

create policy "Members can delete their messages"
on public.chat_messages for delete to authenticated
using (user_id = auth.uid());

create or replace function public.create_watch_room(
  p_nickname text,
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
  v_code text;
  v_room public.watch_rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  p_nickname := btrim(p_nickname);
  p_title_name := btrim(p_title_name);
  if char_length(p_nickname) not between 1 and 24 then raise exception 'Nickname must be 1 to 24 characters'; end if;
  if char_length(p_title_name) not between 1 and 160 then raise exception 'Title is invalid'; end if;
  if p_media_type not in ('movie', 'tv') then raise exception 'Media type is invalid'; end if;
  if p_trailer_key !~ '^[A-Za-z0-9_-]{5,32}$' then raise exception 'Trailer is invalid'; end if;

  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::integer, 1), '')
    into v_code from generate_series(1, 6);
    exit when not exists (select 1 from public.watch_rooms where code = v_code);
  end loop;

  insert into public.watch_rooms (code, host_id, title_id, media_type, title_name, trailer_key)
  values (v_code, auth.uid(), p_title_id, p_media_type, p_title_name, p_trailer_key)
  returning * into v_room;

  insert into public.room_members (room_id, user_id, nickname)
  values (v_room.id, auth.uid(), p_nickname);

  return next v_room;
end;
$$;

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

  insert into public.room_members (room_id, user_id, nickname)
  values (v_room.id, auth.uid(), p_nickname)
  on conflict (room_id, user_id) do update set nickname = excluded.nickname;

  return next v_room;
end;
$$;

create or replace function public.leave_watch_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if exists (select 1 from public.watch_rooms where id = p_room_id and host_id = auth.uid()) then
    delete from public.watch_rooms where id = p_room_id;
  else
    delete from public.room_members where room_id = p_room_id and user_id = auth.uid();
  end if;
end;
$$;

revoke all on public.watch_rooms, public.room_members, public.chat_messages from anon, public;
revoke all on function public.is_room_member(uuid), public.current_room_nickname(uuid), public.create_watch_room(text, bigint, text, text, text), public.join_watch_room(text, text), public.leave_watch_room(uuid) from public, anon;

grant select on public.watch_rooms to authenticated;
grant update (playback_state, playback_position, playback_updated_at) on public.watch_rooms to authenticated;
grant select, delete on public.room_members to authenticated;
grant select, insert, delete on public.chat_messages to authenticated;
grant execute on function public.is_room_member(uuid), public.current_room_nickname(uuid), public.create_watch_room(text, bigint, text, text, text), public.join_watch_room(text, text), public.leave_watch_room(uuid) to authenticated;

alter table public.watch_rooms replica identity full;
alter table public.room_members replica identity full;
alter table public.chat_messages replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'watch_rooms') then
    alter publication supabase_realtime add table public.watch_rooms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_members') then
    alter publication supabase_realtime add table public.room_members;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;
