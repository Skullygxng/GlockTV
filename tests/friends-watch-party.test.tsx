import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { TmdbClient } from '../src/lib/tmdb';

const item: MediaItem = {
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

const tmdbClient: TmdbClient = {
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

const room = {
  id: 'room-1',
  code: 'HEAT95',
  hostId: 'user-1',
  titleId: 1,
  mediaType: 'movie' as const,
  titleName: 'Heat',
  playbackState: 'paused' as const,
  playbackPosition: 0,
  playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
  seasonNumber: 1,
  episodeNumber: 1,
  backdropPath: '/heat-backdrop.jpg',
  durationSeconds: 10200,
  isPublic: false,
  isOfficial: false,
  serverId: 'cinesrc',
  isLocked: false,
  slowModeSeconds: 0,
};

const publicRoom = {
  ...room,
  id: 'public-1',
  code: 'GLOCK1',
  hostId: null,
  isPublic: true,
  isOfficial: true,
  audienceCount: 4,
};

const partyPlaybackConfig = {
  movieUrlTemplate: 'https://party.example/movie/{tmdb_id}',
  tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}',
};

function makePartyService() {
  return {
    ensureUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    createRoom: vi.fn().mockResolvedValue(room),
    joinRoom: vi.fn().mockResolvedValue(room),
    getRoom: vi.fn().mockResolvedValue(room),
    getMembers: vi.fn().mockResolvedValue([
      {
        userId: 'user-1',
        nickname: 'Skully',
        joinedAt: '2026-08-11T00:00:00.000Z',
        isMuted: false,
        isCohost: false,
        lastSeenAt: '2026-08-11T00:00:00.000Z',
        syncStatus: 'synced',
        syncOffsetSeconds: 0,
        serverId: 'cinesrc',
      },
    ]),
    listPublicRooms: vi.fn().mockResolvedValue([publicRoom]),
    getMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue({
      id: 'message-1',
      roomId: 'room-1',
      userId: 'user-1',
      nickname: 'Skully',
      body: 'Ready?',
      createdAt: '2026-08-11T00:00:00.000Z',
    }),
    updatePlayback: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(room),
    applyOfficialLoungeTitle: vi.fn().mockResolvedValue(publicRoom),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    leaveRoom: vi.fn().mockResolvedValue(undefined),
    setMemberMuted: vi.fn().mockResolvedValue(undefined),
    removeMember: vi.fn().mockResolvedValue(undefined),
    getMembershipStatus: vi.fn().mockResolvedValue('active'),
    heartbeatRoom: vi.fn().mockResolvedValue(room),
    setCohost: vi.fn().mockResolvedValue(undefined),
    transferHost: vi.fn().mockResolvedValue(room),
    setRoomServer: vi.fn().mockResolvedValue(room),
    setRoomControls: vi.fn().mockResolvedValue(room),
    clearChat: vi.fn().mockResolvedValue(undefined),
    getBannedMembers: vi.fn().mockResolvedValue([]),
    unbanMember: vi.fn().mockResolvedValue(undefined),
    blockUser: vi.fn().mockResolvedValue(undefined),
    getBlockedUsers: vi.fn().mockResolvedValue([]),
    reportMessage: vi.fn().mockResolvedValue(undefined),
    getAccount: vi.fn().mockResolvedValue({ id: 'user-1', email: null, isAnonymous: true }),
    linkEmail: vi.fn().mockResolvedValue(undefined),
    sendSignInLink: vi.fn().mockResolvedValue(undefined),
    updateEpisode: vi.fn().mockResolvedValue(room),
  };
}

describe('Friends watch parties', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('opens the Friends lobby instead of Channels', async () => {
    render(<App client={tmdbClient} partyService={makePartyService() as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    expect(await screen.findByRole('heading', { name: /Movie night/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create private room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Join room' })).toBeInTheDocument();
  });

  it('creates a private room around the active title', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    expect(await screen.findByText('HEAT95')).toBeInTheDocument();
    expect(partyService.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      nickname: 'Skully',
      titleId: 1,
      titleName: 'Heat',
    }));
    expect(screen.getByRole('textbox', { name: 'Message the room' })).toBeInTheDocument();
  });

  it('waits for an explicit join click on an invite link', async () => {
    const partyService = makePartyService();
    sessionStorage.setItem('glocktv-nickname', 'Returning guest');
    window.history.replaceState({}, '', '/?room=heat95');
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('button', { name: 'Join invite' });
    expect(partyService.joinRoom).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Join invite' }));
    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Returning guest'));
  });

  it('explains that the public lounge uses an automated host', async () => {
    const partyService = makePartyService();
    partyService.joinRoom.mockResolvedValueOnce(publicRoom);
    partyService.getRoom.mockResolvedValue(publicRoom);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));
    expect(await screen.findByText(/Automated GlockTV host/i)).toBeInTheDocument();
  });
});
