import { describe, expect, it } from 'vitest';
import loungeAuthMigrationSource from '../supabase/migrations/20260828020000_official_lounge_vote_authorization.sql?raw';
import privateTitleMigrationSource from '../supabase/migrations/20260811123000_full_title_watch_rooms.sql?raw';
import { encodeLoungeVote, loungeNextUp, tallyLoungeVotes } from '../src/lib/lounge';
import type { MediaItem } from '../src/lib/media';

const heat: MediaItem = {
  id: 1, mediaType: 'movie', title: 'Heat', overview: '', date: '1995-12-15', year: '1995',
  genreIds: [80], genres: ['Crime'], rating: 8, voteCount: 1, popularity: 90, runtime: 170,
  posterPath: null, backdropPath: null,
};
const matrix: MediaItem = { ...heat, id: 603, title: 'The Matrix' };

describe('official lounge vote authorization', () => {
  it('rejects an arbitrary title that is not the lounge vote winner', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain("raise exception 'That title is not the current lounge winner'");
    expect(sql).toContain("raise exception 'The lounge has no votes to apply'");
    expect(sql).toContain("chr(8288) || 'VOTE|'");
    expect(sql).not.toMatch(/delete from public\.chat_messages/i);
  });

  it('still grants the official RPC only to authenticated members', () => {
    const sql = loungeAuthMigrationSource.toLowerCase();
    expect(sql).toContain('security definer');
    expect(sql).toContain('join the lounge before changing the title');
    expect(sql).toContain('revoke all on function public.apply_official_lounge_title');
    expect(sql).toContain('grant execute on function public.apply_official_lounge_title');
    expect(sql).toContain('to authenticated');
  });

  it('leaves private title-change RPC behavior unchanged', () => {
    expect(privateTitleMigrationSource).toContain('update_watch_room_title');
    expect(privateTitleMigrationSource).toContain('Only the room host can change the title');
    expect(loungeAuthMigrationSource).not.toContain('update_watch_room_title');
  });

  it('keeps vote-marker encoding compatible with server-side parsing', () => {
    const encoded = encodeLoungeVote(matrix);
    expect(encoded.startsWith('\u2060VOTE|')).toBe(true);
    expect(encoded).toBe('\u2060VOTE|movie:603:The Matrix');
    const tallied = tallyLoungeVotes([
      { id: '1', roomId: 'r', userId: 'a', nickname: 'A', body: encoded, createdAt: '2026-08-27T01:00:00.000Z' },
      { id: '2', roomId: 'r', userId: 'b', nickname: 'B', body: encodeLoungeVote(heat), createdAt: '2026-08-27T00:59:00.000Z' },
    ], '2026-08-27T00:59:30.000Z');
    expect(tallied[0]?.vote.titleId).toBe(603);
    expect(loungeNextUp([heat, matrix], 1, tallied)?.id).toBe(603);
  });
});
