import { describe, expect, it } from 'vitest';
import {
  encodeLoungeVote,
  loungeBallot,
  loungeNextUp,
  loungeShouldAdvance,
  parseLoungeVote,
  tallyLoungeVotes,
  visiblePartyMessages,
  visibleRoomChat,
} from '../src/lib/lounge';
import type { MediaItem } from '../src/lib/media';

const heat: MediaItem = {
  id: 1, mediaType: 'movie', title: 'Heat', overview: '', date: '1995-12-15', year: '1995',
  genreIds: [80], genres: ['Crime'], rating: 8, voteCount: 1, popularity: 90, runtime: 170,
  posterPath: null, backdropPath: null,
};
const matrix: MediaItem = { ...heat, id: 603, title: 'The Matrix' };

describe('lounge chat and voting', () => {
  it('hides vote messages and drops chat from the previous title', () => {
    const messages = [
      { id: '1', roomId: 'r', userId: 'a', nickname: 'A', body: 'old', createdAt: '2026-08-27T00:00:00.000Z' },
      { id: '2', roomId: 'r', userId: 'a', nickname: 'A', body: encodeLoungeVote(matrix), createdAt: '2026-08-27T01:00:00.000Z' },
      { id: '3', roomId: 'r', userId: 'b', nickname: 'B', body: 'new', createdAt: '2026-08-27T01:01:00.000Z' },
    ];
    const visible = visiblePartyMessages(messages, {
      titleChangedAt: '2026-08-27T01:00:30.000Z',
      now: Date.parse('2026-08-27T01:02:00.000Z'),
    });
    expect(visible.map((item) => item.body)).toEqual(['new']);
  });

  it('counts one vote per person and prefers the leader for next up', () => {
    const messages = [
      { id: '1', roomId: 'r', userId: 'a', nickname: 'A', body: encodeLoungeVote(matrix), createdAt: '2026-08-27T01:00:00.000Z' },
      { id: '2', roomId: 'r', userId: 'b', nickname: 'B', body: encodeLoungeVote(matrix), createdAt: '2026-08-27T01:00:01.000Z' },
      { id: '3', roomId: 'r', userId: 'a', nickname: 'A', body: encodeLoungeVote(heat), createdAt: '2026-08-27T01:00:02.000Z' },
    ];
    const tallied = tallyLoungeVotes(messages);
    expect(parseLoungeVote(messages[0])?.titleId).toBe(603);
    expect(tallied).toEqual(expect.arrayContaining([
      expect.objectContaining({ count: 1, vote: expect.objectContaining({ titleId: 603 }) }),
      expect.objectContaining({ count: 1, vote: expect.objectContaining({ titleId: 1 }) }),
    ]));
    expect(loungeNextUp([heat, matrix], 1, tallied)?.id).toBe(603);
    expect(loungeBallot([heat, matrix], 1).map((item) => item.id)).toEqual([603]);
  });

  it('applies TTL and title-change filters only to the official public lounge', () => {
    const messages = [
      { id: '1', roomId: 'r', userId: 'a', nickname: 'A', body: 'keep-private', createdAt: '2026-08-27T00:00:00.000Z' },
      { id: '2', roomId: 'r', userId: 'a', nickname: 'A', body: encodeLoungeVote(matrix), createdAt: '2026-08-27T01:00:00.000Z' },
      { id: '3', roomId: 'r', userId: 'b', nickname: 'B', body: 'keep-official', createdAt: '2026-08-27T01:01:00.000Z' },
    ];
    const privateVisible = visibleRoomChat(messages, {
      isOfficial: false,
      isPublic: false,
      playbackUpdatedAt: '2026-08-27T01:00:30.000Z',
    }, { now: Date.parse('2026-08-27T03:00:00.000Z') });
    expect(privateVisible.map((item) => item.body)).toEqual([
      'keep-private',
      encodeLoungeVote(matrix),
      'keep-official',
    ]);

    const officialVisible = visibleRoomChat(messages, {
      isOfficial: true,
      isPublic: true,
      playbackUpdatedAt: '2026-08-27T01:00:30.000Z',
    }, { now: Date.parse('2026-08-27T01:02:00.000Z') });
    expect(officialVisible.map((item) => item.body)).toEqual(['keep-official']);
  });

  it('advances when the shared runtime is over', () => {
    expect(loungeShouldAdvance({
      durationSeconds: 120,
      playbackPosition: 0,
      playbackState: 'playing',
      playbackUpdatedAt: new Date(Date.now() - 130_000).toISOString(),
    })).toBe(true);
    expect(loungeShouldAdvance({
      durationSeconds: 7200,
      playbackPosition: 10,
      playbackState: 'playing',
      playbackUpdatedAt: new Date().toISOString(),
    })).toBe(false);
  });
});
