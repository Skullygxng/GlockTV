import { describe, expect, it } from 'vitest';
import reliabilityMigrationSource from '../supabase/migrations/20260818042433_room_reliability_suite.sql?raw';

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

  it('adds private block/report/profile data with row-level security', () => {
    const sql = reliabilityMigration();
    expect(sql).toContain('create table if not exists public.user_blocks');
    expect(sql).toContain('create table if not exists public.message_reports');
    expect(sql).toContain('create table if not exists public.profiles');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('report_watch_room_message');
  });
});
