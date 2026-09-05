import { describe, expect, it } from 'vitest';
import reliabilityMigrationSource from '../supabase/migrations/20260818044028_room_reliability_suite.sql?raw';
import loungeAuthMigrationSource from '../supabase/migrations/20260828044659_official_lounge_vote_authorization_hotfix.sql?raw';

const reliabilityMigration = () => reliabilityMigrationSource.toLowerCase();

describe('watch party database enforcement', () => {
  it('stores heartbeat, co-host, sync, shared server, and room safety state', () => {
    const sql = reliabilityMigration();
    expect(sql).toContain('last_seen_at');
    expect(sql).toContain('is_cohost');
    expect(sql).toContain('sync_status');
    expect(sql).toContain('server_id');
    expect(sql).toContain('is_locked');
    expect(sql).toContain('slow_mode_seconds');
  });

  it('enforces host transfer, moderation recovery, heartbeat, and chat safety through RPCs', () => {
    const sql = reliabilityMigration();
    expect(sql).toContain('heartbeat_watch_room');
    expect(sql).toContain('transfer_watch_room_host');
    expect(sql).toContain('set_watch_room_cohost');
    expect(sql).toContain('unban_watch_room_member');
    expect(sql).toContain('clear_watch_room_chat');
    expect(sql).toContain('chat slow mode');
    expect(sql).toContain('duplicate message');
  });

  it('authorizes official lounge title changes from vote winners and no longer wipes chat', () => {
    const sql = loungeAuthMigrationSource.toLowerCase();
    expect(sql).toContain('official_lounge_catalog');
    expect(sql).toContain('official_lounge_ballot');
    expect(sql).toContain('official_lounge_votes');
    expect(sql).toContain('cast_official_lounge_vote');
    expect(sql).toContain('that title is not on the current lounge ballot');
    expect(sql).toContain('the lounge has no votes to apply');
    expect(sql).toContain('the current lounge title is still playing');
    expect(sql).toContain('greatest(90, v_room.duration_seconds - 20)');
    expect(sql).toContain('lounge votes must use the official ballot');
    expect(sql).not.toContain('delete from public.chat_messages');
    expect(sql).toContain('grant execute on function public.apply_official_lounge_title');
    expect(sql).toContain('revoke all on public.official_lounge_catalog, public.official_lounge_ballot, public.official_lounge_votes from public, anon, authenticated');
    expect(sql).toContain('grant select on public.official_lounge_catalog, public.official_lounge_ballot to authenticated');
    expect(sql).not.toContain('grant select on public.official_lounge_votes');
    expect(sql).toContain('for update');
    expect(sql).toContain('order by counted.votes desc, counted.latest_at desc, b.title_name, b.media_type, b.title_id');
  });

  it('adds private block/report/profile data with row-level security', () => {
    const sql = reliabilityMigration();
    expect(sql).toContain('create table if not exists public.user_blocks');
    expect(sql).toContain('create table if not exists public.message_reports');
    expect(sql).toContain('create table if not exists public.profiles');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('report_watch_room_message');
  });
});
