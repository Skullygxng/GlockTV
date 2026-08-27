import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { MediaItem } from '../src/lib/media';
import type { PartySubscriptionHandlers } from '../src/lib/watchParty';
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

const member = {
  userId: 'user-2',
  nickname: 'Guest',
  joinedAt: '2026-08-11T00:00:00.000Z',
  isMuted: false,
  isCohost: false,
  lastSeenAt: '2026-08-11T00:00:00.000Z',
  syncStatus: 'synced' as const,
  syncOffsetSeconds: 0,
  serverId: 'cinesrc',
};

const oldMessage = {
  id: 'message-old',
  roomId: 'room-1',
  userId: 'user-1',
  nickname: 'Host',
  body: 'This should disappear',
  createdAt: '2026-08-11T00:01:00.000Z',
};

const client: TmdbClient = {
  getTrending: vi.fn().mockResolvedValue([item]),
  discover: vi.fn().mockResolvedValue([item]),
  search: vi.fn().mockResolvedValue([item]),
  getPreviewContext: vi.fn().mockResolvedValue({
    details: item,
    trailer: null,
  }),
  getTitleContext: vi.fn().mockResolvedValue({
    details: item,
    trailer: null,
    providers: null,
    providerLink: null,
  }),
  getPersonCredits: vi.fn().mockResolvedValue([]),
};

describe('Friends realtime reconciliation', () => {
  it('authoritatively removes cleared chat for another viewer', async () => {
    let handlers: PartySubscriptionHandlers | undefined;

    const service = {
      ensureUser: vi.fn().mockResolvedValue({ id: 'user-2' }),
      createRoom: vi.fn().mockResolvedValue(room),
      joinRoom: vi.fn().mockResolvedValue(room),
      getRoom: vi.fn().mockResolvedValue(room),
      listPublicRooms: vi.fn().mockResolvedValue([]),
      getMembers: vi.fn().mockResolvedValue([member]),
      getMessages: vi.fn().mockResolvedValue([oldMessage]),
      getBlockedUsers: vi.fn().mockResolvedValue([]),
      getMembershipStatus: vi.fn().mockResolvedValue('active'),
      heartbeatRoom: vi.fn().mockResolvedValue(room),
      subscribe: vi.fn().mockImplementation((_roomId: string, nextHandlers: PartySubscriptionHandlers) => {
        handlers = nextHandlers;
        return () => undefined;
      }),
      sendMessage: vi.fn(),
      updatePlayback: vi.fn(),
      updateTitle: vi.fn(),
      updateEpisode: vi.fn(),
      leaveRoom: vi.fn(),
      setMemberMuted: vi.fn(),
      removeMember: vi.fn(),
      setCohost: vi.fn(),
      transferHost: vi.fn(),
      setRoomServer: vi.fn(),
      setRoomControls: vi.fn(),
      clearChat: vi.fn(),
      getBannedMembers: vi.fn().mockResolvedValue([]),
      unbanMember: vi.fn(),
      blockUser: vi.fn(),
      reportMessage: vi.fn(),
      getAccount: vi.fn().mockResolvedValue(null),
      linkEmail: vi.fn(),
      sendSignInLink: vi.fn(),
    };

    window.history.replaceState({}, '', '/');

    render(
      <App
        client={client}
        partyService={service as never}
        partyPlaybackConfig={{
          movieUrlTemplate: 'https://party.example/movie/{tmdb_id}',
          tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}',
        }}
      />,
    );

    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Primary navigation' }))
        .getByRole('button', { name: 'Friends' }),
    );

    fireEvent.change(await screen.findByLabelText('Your nickname'), {
      target: { value: 'Guest' },
    });
    fireEvent.change(screen.getByLabelText('Room code'), {
      target: { value: 'heat95' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByText('This should disappear')).toBeInTheDocument();
    await waitFor(() => expect(handlers).toBeDefined());

    service.getMessages.mockResolvedValue([]);

    act(() => {
      handlers?.onChatCleared?.();
    });

    await waitFor(() => {
      expect(screen.queryByText('This should disappear')).not.toBeInTheDocument();
    });
    expect(screen.getByText('The room is quiet')).toBeInTheDocument();
    expect(service.getMessages).toHaveBeenCalledTimes(2);
  });
});