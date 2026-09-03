-- Personal playback progress.
--
-- This is one person's place in one title, and nothing else. It is emphatically
-- NOT watch-party state: a room's playback position lives on watch_rooms and is
-- shared by everybody in the room, while this row is private and follows the
-- viewer between devices. Keeping them apart is why joining a friend's party
-- cannot rewrite your own Continue Watching, and why leaving a party does not
-- lose your place.
--
-- Every row is written by the browser, as the owner, under RLS. There is no
-- service-role path and no SECURITY DEFINER function here on purpose: progress
-- is not a privileged fact. The worst a compromised session can do is lie about
-- where its own owner got to in a film, which is why this table is safe to let
-- the client write while account_entitlements is not.
--
-- Rollback: drop the policies, then the table. Nothing else references it, so
-- reverting loses cloud progress and leaves each device's local progress
-- untouched - the same state a signed-out visitor has today.

create table if not exists public.watch_progress (
  user_id uuid not null references auth.users(id) on delete cascade,

  media_type text not null check (media_type in ('movie', 'tv')),
  media_id integer not null check (media_id > 0),

  -- Zero means "not episodic". They are part of the primary key, so they
  -- cannot be null, and a movie needs a single definite row rather than one
  -- per accidental season value.
  season_number integer not null default 0 check (season_number >= 0),
  episode_number integer not null default 0 check (episode_number >= 0),

  position_seconds integer not null check (position_seconds >= 0),

  -- Null when the provider never told us. A player that reports position but
  -- not length is normal, and guessing a length would produce a progress bar
  -- that lies.
  duration_seconds integer check (duration_seconds is null or duration_seconds > 0),

  -- Decided by the client from real observed position against real observed
  -- duration, then stored so Continue Watching does not have to recompute a
  -- threshold on every read and so a finished title stops occupying the row.
  completed boolean not null default false,

  -- Which playback server observed this. Resuming into a server that cannot
  -- accept a start time would drop the viewer at zero, so the surface needs to
  -- know where the number came from.
  provider_id text,

  -- Enough to draw a Continue Watching tile on a device that has never seen
  -- this title. Without it a signed-in viewer on a new phone gets a list of
  -- ids it cannot render, and GlockTV supports running with no TMDB key at
  -- all. Same snapshot approach My List already takes in local storage.
  title text not null default '',
  poster_path text,
  backdrop_path text,

  /*
   * Cloud recency, and the only timestamp anything is allowed to trust.
   *
   * Set by the database on every insert and update - see the trigger below -
   * and deliberately not grantable to the browser, so a device with a wrong or
   * hostile clock cannot establish a future cloud state that then wins every
   * comparison forever. The column default alone would not be enough: it
   * applies only when the value is omitted, and a modified client posting
   * straight to PostgREST would simply name it.
   */
  updated_at timestamptz not null default now(),

  /*
   * When the browser says it observed this position. Untrusted by
   * construction: it is a client clock, it is never compared against a cloud
   * timestamp to decide a winner, and nothing breaks if it is absurd. Kept
   * because "recorded at 9am, uploaded at 5pm" is worth being able to see when
   * a resume point looks wrong.
   */
  observed_at timestamptz,

  primary key (user_id, media_type, media_id, season_number, episode_number)
);

/*
 * The database decides when a row was last written, not the writer.
 *
 * This is what makes updated_at authoritative rather than merely
 * conventional. A client that omits it gets now() from the default; a client
 * that sends one - including one posting directly to PostgREST with a forged
 * future value - has it overwritten here before the row is stored. The column
 * grants below also withhold updated_at, so such a request is refused before
 * it arrives; the trigger is the guarantee that holds even if a future grant
 * is written more loosely.
 */
create or replace function public.stamp_watch_progress_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists watch_progress_stamp_updated_at on public.watch_progress;
create trigger watch_progress_stamp_updated_at
before insert or update on public.watch_progress
for each row execute function public.stamp_watch_progress_updated_at();

-- The Continue Watching read is "my unfinished rows, newest first". The primary
-- key already leads with user_id but says nothing about recency, so the sort
-- would be a filesort over everything that person has ever watched.
create index if not exists watch_progress_user_recent_idx
  on public.watch_progress (user_id, updated_at desc);

alter table public.watch_progress enable row level security;

revoke all on public.watch_progress from public, anon, authenticated;

-- Column-level, so updated_at is not merely omitted by today's client but
-- absent from what a browser is permitted to name at all. Delete is deliberate:
-- removing something from Continue Watching is the viewer's own decision about
-- their own history, not an administrative act.
grant select, delete on public.watch_progress to authenticated;
grant insert (
  user_id, media_type, media_id, season_number, episode_number,
  position_seconds, duration_seconds, completed, provider_id,
  title, poster_path, backdrop_path, observed_at
) on public.watch_progress to authenticated;
grant update (
  position_seconds, duration_seconds, completed, provider_id,
  title, poster_path, backdrop_path, observed_at
) on public.watch_progress to authenticated;

drop policy if exists "Viewers read their own progress" on public.watch_progress;
create policy "Viewers read their own progress"
on public.watch_progress for select to authenticated
using (user_id = (select auth.uid()));

-- with check on insert, and both using and with check on update, so a row can
-- neither be created for somebody else nor be moved to them afterwards.
/*
 * Cloud progress is for a protected account. An anonymous session gets the
 * device-local layer and nothing here.
 *
 * Enforced at this boundary and not only in the client, because a guest's
 * session holds the same publishable key everybody else does and could post
 * directly. The identity itself is unchanged by protecting an account -
 * Supabase keeps the same uid when an email is attached - so a guest's local
 * history becomes eligible for sync under the very same user_id, with nothing
 * migrated and nothing deleted.
 */
drop policy if exists "Viewers record their own progress" on public.watch_progress;
create policy "Viewers record their own progress"
on public.watch_progress for insert to authenticated
with check (
  user_id = (select auth.uid())
  and coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

drop policy if exists "Viewers update their own progress" on public.watch_progress;
create policy "Viewers update their own progress"
on public.watch_progress for update to authenticated
using (
  user_id = (select auth.uid())
  and coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false
)
with check (
  user_id = (select auth.uid())
  and coalesce((select auth.jwt() ->> 'is_anonymous')::boolean, false) = false
);

drop policy if exists "Viewers forget their own progress" on public.watch_progress;
create policy "Viewers forget their own progress"
on public.watch_progress for delete to authenticated
using (user_id = (select auth.uid()));
