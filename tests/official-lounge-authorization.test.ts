import { describe, expect, it } from 'vitest';
import loungeAuthMigrationSource from '../supabase/migrations/20260828020000_official_lounge_vote_authorization.sql?raw';
import privateTitleMigrationSource from '../supabase/migrations/20260811123000_full_title_watch_rooms.sql?raw';
import { officialBallotTallies, officialBallotWinner } from '../src/lib/lounge';
import type { OfficialLoungeBallotEntry } from '../src/lib/watchParty';

const cycle = '2026-08-27T01:00:00.000Z';
const previousCycle = '2026-08-27T00:00:00.000Z';

function entry(overrides: Partial<OfficialLoungeBallotEntry>): OfficialLoungeBallotEntry {
  return {
    mediaType: 'movie',
    titleId: 603,
    titleName: 'The Matrix',
    backdropPath: '/matrix-backdrop.jpg',
    durationSeconds: 8100,
    voteCount: 0,
    isMine: false,
    cycleStartedAt: cycle,
    ...overrides,
  };
}

describe('official lounge vote authorization', () => {
  it('rejects forged chat votes and titles outside the current ballot', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain("raise exception 'That title is not on the current lounge ballot'");
    expect(sql).toContain("raise exception 'Lounge votes must use the official ballot'");
    expect(sql).toContain("raise exception 'The lounge has no votes to apply'");
    expect(sql).toContain('cast_official_lounge_vote');
    expect(sql).toContain('official_lounge_catalog');
    expect(sql).not.toMatch(/delete from public\.chat_messages/i);
    expect(sql).not.toContain('p_title_name');
  });

  it('still grants official RPCs only to authenticated members', () => {
    const sql = loungeAuthMigrationSource.toLowerCase();
    expect(sql).toContain('security definer');
    expect(sql).toContain('join the lounge before voting');
    expect(sql).toContain('join the lounge before changing the title');
    expect(sql).toContain('revoke all on function public.cast_official_lounge_vote');
    expect(sql).toContain('grant execute on function public.cast_official_lounge_vote');
    expect(sql).toContain('to authenticated');
  });

  it('leaves private title-change RPC behavior unchanged', () => {
    expect(privateTitleMigrationSource).toContain('update_watch_room_title');
    expect(privateTitleMigrationSource).toContain('Only the room host can change the title');
    expect(loungeAuthMigrationSource).not.toContain('update_watch_room_title');
  });

  it('counts only current-cycle ballot votes and uses ballot metadata', () => {
    const current = [
      entry({ titleId: 603, titleName: 'The Matrix', voteCount: 1, isMine: true }),
      entry({ titleId: 807, titleName: 'Se7en', voteCount: 2 }),
    ];
    expect(officialBallotWinner(current)?.titleId).toBe(807);
    expect(officialBallotTallies(current).map((item) => item.vote.titleId)).toEqual([807, 603]);

    const stale = [entry({ titleId: 550, titleName: 'Fight Club', voteCount: 9, cycleStartedAt: previousCycle })];
    expect(stale[0]?.cycleStartedAt).not.toBe(cycle);
  });

  it('rejects early rotation before the current title is effectively finished', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain("raise exception 'The current lounge title is still playing'");
    expect(sql).toContain('coalesce(v_room.duration_seconds, 0) <= 0');
    expect(sql).toContain("v_room.playback_state = 'paused'");
    expect(sql).toContain('v_effective_position := v_room.playback_position');
    expect(sql).toContain('extract(epoch from (now() - v_room.playback_updated_at))');
    expect(sql).toContain('v_effective_position < greatest(90, v_room.duration_seconds - 20)');
    expect(sql).toContain("raise exception 'The lounge just changed titles. Vote on the next one.'");
    expect(sql).toContain("raise exception 'The lounge has no votes to apply'");
  });

  it('does not let client-supplied fake metadata invent a winner', () => {
    const sql = loungeAuthMigrationSource;
    expect(sql).toContain('v_winner.title_name');
    expect(sql).toContain('v_winner.backdrop_path');
    expect(sql).toContain('v_winner.duration_seconds');
    expect(sql).not.toContain('p_title_name := btrim');
    expect(sql).toContain('create table if not exists public.official_lounge_catalog');
    expect(sql).toContain('grant select on public.official_lounge_catalog');
    expect(sql.toLowerCase()).not.toContain('grant insert on public.official_lounge_catalog');
    expect(sql.toLowerCase()).not.toContain('grant update on public.official_lounge_catalog');
    expect(sql.toLowerCase()).not.toContain('grant delete on public.official_lounge_catalog');
  });
});
