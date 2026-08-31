import { vi } from 'vitest';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

export const item: MediaItem = {
  id: 1,
  mediaType: 'movie',
  title: 'Heat',
  overview: 'A master thief and a relentless detective collide in Los Angeles.',
  date: '1995-12-15',
  year: '1995',
  genreIds: [80, 18],
  genres: ['Crime', 'Drama'],
  rating: 8.3,
  voteCount: 7200,
  popularity: 90,
  runtime: 170,
  posterPath: '/heat.jpg',
  backdropPath: '/heat-backdrop.jpg',
};

export const matrix: MediaItem = {
  ...item,
  id: 603,
  title: 'The Matrix',
  year: '1999',
  posterPath: '/matrix.jpg',
  backdropPath: '/matrix-backdrop.jpg',
};

export const tmdbClient: TmdbClient = {
  getTrending: vi.fn().mockResolvedValue([item]),
  discover: vi.fn().mockResolvedValue([item]),
  search: vi.fn().mockResolvedValue([item]),
  getTitleContext: vi.fn().mockResolvedValue({
    trailer: { key: 'heat-trailer', site: 'YouTube', type: 'Trailer', official: true },
    providers: null,
    providerLink: null,
    details: item,
  }),
  getPersonCredits: vi.fn().mockResolvedValue([item]),
};

export const room = {
  id: 'room-1',
  code: 'HEAT95',
  hostId: 'user-1',
  titleId: 1,
  mediaType: 'movie' as const,
  titleName: 'Heat',
  playbackState: 'paused' as const,
  playbackPosition: 0,
  playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
  seasonNumber: 1, episodeNumber: 1,
  backdropPath: '/heat-backdrop.jpg', durationSeconds: 10200,
  isPublic: false, isOfficial: false,
  serverId: 'cinesrc', isLocked: false, slowModeSeconds: 0,
};

/*
 * The room shape the fake serves. Widened where the real thing is wider: an
 * official lounge has no host, and carries an audience count. The old mocks
 * erased this through mockResolvedValue's loose typing; stating it keeps the
 * lounge overrides in the other suites type-checked rather than untyped.
 */
export type PartyRoomFixture = Omit<
  typeof room,
  'hostId' | 'mediaType' | 'playbackState' | 'backdropPath' | 'durationSeconds'
> & {
  hostId: string | null;
  mediaType: 'movie' | 'tv';
  playbackState: 'paused' | 'playing';
  backdropPath: string | null;
  durationSeconds: number | null;
  audienceCount?: number;
};

export const publicRoom: PartyRoomFixture = { ...room, id: 'public-1', code: 'GLOCK1', hostId: null, isPublic: true, isOfficial: true, audienceCount: 4 };
export const partyPlaybackConfig = { movieUrlTemplate: 'https://party.example/movie/{tmdb_id}', tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}' };

/*
 * A fake party service that remembers what it was told.
 *
 * Every read used to resolve to the frozen `room` above, so the fake modelled
 * a server with amnesia: an optimistic UI update could be silently reverted by
 * a background heartbeat or room refresh landing afterwards with the original
 * values. Whether that landed between two user actions was a scheduling coin
 * flip, which is exactly how a race that cannot happen against a real server
 * showed up as an intermittent test failure.
 *
 * Writes now commit to a per-service room and reads return it, so the fake
 * behaves the way the component is entitled to assume a server behaves. State
 * is created per makePartyService() call, so nothing leaks between tests.
 */
export function makePartyService() {
  let current: PartyRoomFixture = { ...room };
  const commit = (patch: Partial<PartyRoomFixture>) => {
    // A new object each time, so React sees a changed reference on a write and
    // an unchanged one on a plain read.
    current = { ...current, ...patch };
    return current;
  };

  return {
    ensureUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    createRoom: vi.fn(async (..._args: unknown[]) => current),
    joinRoom: vi.fn(async (..._args: unknown[]) => current),
    getRoom: vi.fn(async (_roomId: string) => current),
    getMembers: vi.fn().mockResolvedValue([{ userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: '2026-08-11T00:00:00.000Z', syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' }]),
    listPublicRooms: vi.fn().mockResolvedValue([publicRoom]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ id: 'message-1', roomId: 'room-1', userId: 'user-1', nickname: 'Skully', body: 'Ready?', createdAt: '2026-08-11T00:00:00.000Z' }),
    updatePlayback: vi.fn().mockResolvedValue(undefined),
    applyOfficialLoungeTitle: vi.fn().mockResolvedValue(publicRoom),
    getOfficialLoungeBallot: vi.fn().mockResolvedValue([]),
    castOfficialLoungeVote: vi.fn().mockResolvedValue([]),
    updateTitle: vi.fn(async (_roomId: string, input: { titleId: number; mediaType: 'movie' | 'tv'; titleName: string; backdropPath: string | null; durationSeconds: number | null }) =>
      commit({
        titleId: input.titleId,
        mediaType: input.mediaType,
        titleName: input.titleName,
        backdropPath: input.backdropPath,
        durationSeconds: input.durationSeconds,
        playbackPosition: 0,
      })),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    setMemberMuted: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    getMembershipStatus: vi.fn().mockResolvedValue('active'),
    heartbeatRoom: vi.fn(async (_roomId: string, _presence?: unknown) => current),
    setCohost: vi.fn().mockResolvedValue(undefined),
    transferHost: vi.fn(async (_roomId: string, userId: string) => commit({ hostId: userId })),
    setRoomServer: vi.fn(async (_roomId: string, serverId: string) => commit({ serverId })),
    setRoomControls: vi.fn(async (_roomId: string, controls: { isLocked: boolean; slowModeSeconds: number }) => commit(controls)),
    clearChat: vi.fn().mockResolvedValue(undefined),
    getBannedMembers: vi.fn().mockResolvedValue([]),
    unbanMember: vi.fn().mockResolvedValue(undefined),
    blockUser: vi.fn().mockResolvedValue(undefined),
    getBlockedUsers: vi.fn().mockResolvedValue([]),
    reportMessage: vi.fn().mockResolvedValue(undefined),
    updateEpisode: vi.fn(async (_roomId: string, seasonNumber: number, episodeNumber: number) => commit({ seasonNumber, episodeNumber })),
  };
}
