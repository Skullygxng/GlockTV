-- Authoritative official-lounge ballot. Members can only vote for current-cycle
-- catalog candidates. Chat is no longer the vote-write API. Title metadata comes
-- from ballot rows, not client arguments. Chat is not deleted on rotation.

create table if not exists public.official_lounge_catalog (
  media_type text not null check (media_type in ('movie', 'tv')),
  title_id bigint not null,
  title_name text not null check (char_length(btrim(title_name)) between 1 and 160),
  backdrop_path text,
  duration_seconds integer,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  primary key (media_type, title_id)
);

create table if not exists public.official_lounge_ballot (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  cycle_started_at timestamptz not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  title_id bigint not null,
  title_name text not null,
  backdrop_path text,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  primary key (room_id, cycle_started_at, media_type, title_id)
);

create table if not exists public.official_lounge_votes (
  room_id uuid not null references public.watch_rooms(id) on delete cascade,
  cycle_started_at timestamptz not null,
  user_id uuid not null,
  media_type text not null check (media_type in ('movie', 'tv')),
  title_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (room_id, cycle_started_at, user_id)
);

create index if not exists official_lounge_votes_title_idx
  on public.official_lounge_votes (room_id, cycle_started_at, media_type, title_id);

alter table public.official_lounge_catalog enable row level security;
alter table public.official_lounge_ballot enable row level security;
alter table public.official_lounge_votes enable row level security;

drop policy if exists official_lounge_catalog_select on public.official_lounge_catalog;
create policy official_lounge_catalog_select
  on public.official_lounge_catalog for select to authenticated
  using (true);

drop policy if exists official_lounge_ballot_select on public.official_lounge_ballot;
create policy official_lounge_ballot_select
  on public.official_lounge_ballot for select to authenticated
  using (
    exists (
      select 1 from public.watch_rooms r
      where r.id = room_id and r.is_official and r.is_public
    )
  );

drop policy if exists official_lounge_votes_select on public.official_lounge_votes;
create policy official_lounge_votes_select
  on public.official_lounge_votes for select to authenticated
  using (
    exists (
      select 1 from public.watch_rooms r
      where r.id = room_id and r.is_official and r.is_public
    )
  );

revoke all on public.official_lounge_catalog, public.official_lounge_ballot, public.official_lounge_votes from public, anon;
grant select on public.official_lounge_catalog, public.official_lounge_ballot, public.official_lounge_votes to authenticated;

insert into public.official_lounge_catalog (media_type, title_id, title_name, backdrop_path, duration_seconds, sort_order)
values
  ('movie', 603, 'The Matrix', '/matrix-backdrop.jpg', 8100, 10),
  ('movie', 807, 'Se7en', '/se7en-backdrop.jpg', 7620, 20),
  ('movie', 550, 'Fight Club', '/fight-club-backdrop.jpg', 8340, 30),
  ('movie', 27205, 'Inception', '/inception-backdrop.jpg', 8880, 40),
  ('movie', 155, 'The Dark Knight', '/tdk-backdrop.jpg', 9120, 50)
on conflict (media_type, title_id) do update
set title_name = excluded.title_name,
    backdrop_path = excluded.backdrop_path,
    duration_seconds = excluded.duration_seconds,
    sort_order = excluded.sort_order,
    is_active = true;

create or replace function public.ensure_official_lounge_ballot(p_room_id uuid)
returns void
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

  select * into v_room
  from public.watch_rooms
  where id = p_room_id
    and is_official
    and is_public
    and expires_at > now();
  if not found then
    raise exception 'Only the public lounge can use the official ballot';
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  ) then
    raise exception 'Join the lounge before using the ballot';
  end if;

  if exists (
    select 1 from public.official_lounge_ballot b
    where b.room_id = p_room_id
      and b.cycle_started_at = v_room.playback_updated_at
  ) then
    return;
  end if;

  insert into public.official_lounge_ballot (
    room_id, cycle_started_at, media_type, title_id, title_name, backdrop_path, duration_seconds
  )
  select p_room_id, v_room.playback_updated_at, c.media_type, c.title_id, c.title_name, c.backdrop_path, c.duration_seconds
  from public.official_lounge_catalog c
  where c.is_active
    and not (c.title_id = v_room.title_id and c.media_type = v_room.media_type)
  order by c.sort_order, c.title_id
  limit 3;
end;
$$;

create or replace function public.get_official_lounge_ballot(p_room_id uuid)
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
begin
  perform public.ensure_official_lounge_ballot(p_room_id);
  return query
  select
    b.media_type,
    b.title_id,
    b.title_name,
    b.backdrop_path,
    b.duration_seconds,
    count(v.user_id)::integer as vote_count,
    bool_or(v.user_id = auth.uid()) as is_mine,
    b.cycle_started_at
  from public.official_lounge_ballot b
  join public.watch_rooms r
    on r.id = b.room_id
   and r.playback_updated_at = b.cycle_started_at
  left join public.official_lounge_votes v
    on v.room_id = b.room_id
   and v.cycle_started_at = b.cycle_started_at
   and v.media_type = b.media_type
   and v.title_id = b.title_id
  where b.room_id = p_room_id
  group by b.media_type, b.title_id, b.title_name, b.backdrop_path, b.duration_seconds, b.cycle_started_at
  order by count(v.user_id) desc, b.title_name;
end;
$$;

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
  on conflict (room_id, cycle_started_at, user_id)
  do update set media_type = excluded.media_type, title_id = excluded.title_id, created_at = now();

  return query select * from public.get_official_lounge_ballot(p_room_id);
end;
$$;

drop function if exists public.apply_official_lounge_title(uuid, bigint, text, text, text, integer);

create function public.apply_official_lounge_title(p_room_id uuid)
returns setof public.watch_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room public.watch_rooms%rowtype;
  v_winner public.official_lounge_ballot%rowtype;
  v_winner_votes integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
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

  perform public.ensure_official_lounge_ballot(p_room_id);

  select counted.votes, b.*
  into v_winner_votes, v_winner
  from (
    select v.media_type, v.title_id, count(*)::integer as votes, max(v.created_at) as latest_at
    from public.official_lounge_votes v
    where v.room_id = p_room_id
      and v.cycle_started_at = v_room.playback_updated_at
    group by v.media_type, v.title_id
    order by count(*) desc, max(v.created_at) desc
    limit 1
  ) counted
  join public.official_lounge_ballot b
    on b.room_id = p_room_id
   and b.cycle_started_at = v_room.playback_updated_at
   and b.media_type = counted.media_type
   and b.title_id = counted.title_id;

  if v_winner.title_id is null or coalesce(v_winner_votes, 0) < 1 then
    raise exception 'The lounge has no votes to apply';
  end if;

  if v_room.title_id = v_winner.title_id and v_room.media_type = v_winner.media_type then
    return next v_room;
    return;
  end if;

  if v_room.playback_updated_at > now() - interval '90 seconds' then
    raise exception 'The lounge just changed titles. Vote on the next one.';
  end if;

  update public.watch_rooms
  set title_id = v_winner.title_id,
      media_type = v_winner.media_type,
      title_name = v_winner.title_name,
      backdrop_path = v_winner.backdrop_path,
      duration_seconds = v_winner.duration_seconds,
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

create or replace function public.send_watch_room_message(p_room_id uuid, p_body text)
returns setof public.chat_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.room_members%rowtype;
  v_room public.watch_rooms%rowtype;
  v_message public.chat_messages%rowtype;
  v_last_at timestamptz;
  v_prefix text := chr(8288) || 'VOTE|';
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_member from public.room_members where room_id = p_room_id and user_id = auth.uid();
  if not found then raise exception 'You are no longer in this room'; end if;
  if v_member.is_muted then raise exception 'The host muted your chat'; end if;
  select * into v_room from public.watch_rooms where id = p_room_id and expires_at > now();
  if not found then raise exception 'Room not found or expired'; end if;
  p_body := btrim(p_body);
  if char_length(p_body) not between 1 and 500 then raise exception 'Message must be 1 to 500 characters'; end if;
  if v_room.is_official and v_room.is_public and left(p_body, char_length(v_prefix)) = v_prefix then
    raise exception 'Lounge votes must use the official ballot';
  end if;
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
end;
$$;

revoke all on function public.ensure_official_lounge_ballot(uuid) from public, anon;
revoke all on function public.get_official_lounge_ballot(uuid) from public, anon;
revoke all on function public.cast_official_lounge_vote(uuid, bigint, text) from public, anon;
revoke all on function public.apply_official_lounge_title(uuid) from public, anon;
revoke all on function public.send_watch_room_message(uuid, text) from public, anon;
grant execute on function public.ensure_official_lounge_ballot(uuid) to authenticated;
grant execute on function public.get_official_lounge_ballot(uuid) to authenticated;
grant execute on function public.cast_official_lounge_vote(uuid, bigint, text) to authenticated;
grant execute on function public.apply_official_lounge_title(uuid) to authenticated;
grant execute on function public.send_watch_room_message(uuid, text) to authenticated;
