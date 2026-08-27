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

export const publicRoom = { ...room, id: 'public-1', code: 'GLOCK1', hostId: null, isPublic: true, isOfficial: true, audienceCount: 4 };
export const partyPlaybackConfig = { movieUrlTemplate: 'https://party.example/movie/{tmdb_id}', tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}' };

export function makePartyService() {
  return {
    ensureUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    createRoom: vi.fn().mockResolvedValue(room),
    joinRoom: vi.fn().mockResolvedValue(room),
    getRoom: vi.fn().mockResolvedValue(room),
    getMembers: vi.fn().mockResolvedValue([{ userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: '2026-08-11T00:00:00.000Z', syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' }]),
    listPublicRooms: vi.fn().mockResolvedValue([publicRoom]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({ id: 'message-1', roomId: 'room-1', userId: 'user-1', nickname: 'Skully', body: 'Ready?', createdAt: '2026-08-11T00:00:00.000Z' }),
    updatePlayback: vi.fn().mockResolvedValue(undefined),
    applyOfficialLoungeTitle: vi.fn().mockResolvedValue(publicRoom),
    updateTitle: vi.fn().mockImplementation(async (_roomId: string, input: { titleId: number; mediaType: 'movie' | 'tv'; titleName: string; backdropPath: string | null; durationSeconds: number | null }) => ({
      ...room,
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
    heartbeatRoom: vi.fn().mockResolvedValue(room),
    setCohost: vi.fn().mockResolvedValue(undefined),
    transferHost: vi.fn().mockImplementation(async (_roomId: string, userId: string) => ({ ...room, hostId: userId })),
    setRoomServer: vi.fn().mockImplementation(async (_roomId: string, serverId: string) => ({ ...room, serverId })),
    setRoomControls: vi.fn().mockImplementation(async (_roomId: string, controls: { isLocked: boolean; slowModeSeconds: number }) => ({ ...room, ...controls })),
    clearChat: vi.fn().mockResolvedValue(undefined),
    getBannedMembers: vi.fn().mockResolvedValue([]),
    unbanMember: vi.fn().mockResolvedValue(undefined),
    blockUser: vi.fn().mockResolvedValue(undefined),
    getBlockedUsers: vi.fn().mockResolvedValue([]),
    reportMessage: vi.fn().mockResolvedValue(undefined),
    getAccount: vi.fn().mockResolvedValue({ id: 'user-1', email: null, isAnonymous: true }),
    linkEmail: vi.fn().mockResolvedValue(undefined),
    sendSignInLink: vi.fn().mockResolvedValue(undefined),
    updateEpisode: vi.fn().mockImplementation(async (_roomId: string, seasonNumber: number, episodeNumber: number) => ({ ...room, seasonNumber, episodeNumber })),
  };
}
