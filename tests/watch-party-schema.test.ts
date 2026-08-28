import { describe, expect, it } from 'vitest';
import reliabilityMigrationSource from '../supabase/migrations/20260818042433_room_reliability_suite.sql?raw';
import loungeMigrationSource from '../supabase/migrations/20260827070000_official_lounge_rotation.sql?raw';
import loungeAuthMigrationSource from '../supabase/migrations/20260828020000_official_lounge_vote_authorization.sql?raw';

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

  it('lets official lounge members rotate the shared title and clear chat', () => {
    const sql = loungeMigrationSource.toLowerCase();
    expect(sql).toContain('apply_official_lounge_title');
    expect(sql).toContain('is_official');
    expect(sql).toContain('delete from public.chat_messages');
  });

  it('authorizes official lounge title changes from vote winners and no longer wipes chat', () => {
    const sql = loungeAuthMigrationSource.toLowerCase();
    expect(sql).toContain('apply_official_lounge_title');
    expect(sql).toContain('that title is not the current lounge winner');
    expect(sql).toContain('the lounge has no votes to apply');
    expect(sql).toContain("chr(8288) || 'vote|'");
    expect(sql).not.toContain('delete from public.chat_messages');
    expect(sql).toContain('grant execute on function public.apply_official_lounge_title');
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
