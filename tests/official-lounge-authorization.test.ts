import { describe, expect, it } from 'vitest';
import loungeAuthMigrationSource from '../supabase/migrations/20260828020000_official_lounge_vote_authorization.sql?raw';
import titleChangeMigrationSource from '../supabase/migrations/20260811123000_full_title_watch_rooms.sql?raw';

describe('official lounge authorization', () => {
  it('requires an authenticated member and official public room', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain('Authentication required');
    expect(sql).toContain('Join the lounge before changing the title');
    expect(sql).toContain('Only the public lounge can rotate titles this way');
    expect(sql).toContain('is_official');
    expect(sql).toContain('is_public');
  });

  it('rejects an arbitrary title that is not the vote winner and keeps chat', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain('That title is not the current lounge winner');
    expect(sql).toContain('The lounge has no votes to apply');
    expect(sql).toContain("chr(8288) || 'VOTE|'");
    expect(sql.toLowerCase()).not.toContain('delete from public.chat_messages');
  });

  it('leaves the private host title RPC unchanged', () => {
    expect(titleChangeMigrationSource).toContain('update_watch_room_title');
    expect(titleChangeMigrationSource).toContain('host_id = auth.uid()');
    expect(titleChangeMigrationSource).toContain('not is_official');
    expect(loungeAuthMigrationSource).not.toContain('update_watch_room_title');
  });
});
