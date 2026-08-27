import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const matrix: MediaItem = {
  ...item,
  id: 603,
  title: 'The Matrix',
  year: '1999',
  posterPath: '/matrix.jpg',
  backdropPath: '/matrix-backdrop.jpg',
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
  seasonNumber: 1, episodeNumber: 1,
  backdropPath: '/heat-backdrop.jpg', durationSeconds: 10200,
  isPublic: false, isOfficial: false,
  serverId: 'cinesrc', isLocked: false, slowModeSeconds: 0,
};
const publicRoom = { ...room, id: 'public-1', code: 'GLOCK1', hostId: null, isPublic: true, isOfficial: true, audienceCount: 4 };
const partyPlaybackConfig = { movieUrlTemplate: 'https://party.example/movie/{tmdb_id}', tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}' };

function makePartyService() {
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

describe('Friends watch parties', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('replaces Channels with a focused Friends lobby', async () => {
    render(<App client={tmdbClient} partyService={makePartyService() as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });

    expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));

    expect(await screen.findByRole('heading', { name: /Movie night/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create private room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Join room' })).toBeInTheDocument();
  });

  it('creates a room around the full active title and opens audience chat', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    await waitFor(() => expect(tmdbClient.getTitleContext).toHaveBeenCalled());

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    expect(await screen.findByText('HEAT95')).toBeInTheDocument();
    expect(partyService.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      nickname: 'Skully',
      titleId: 1,
      titleName: 'Heat',
      backdropPath: '/heat-backdrop.jpg',
      durationSeconds: 10200,
    }));
    expect(screen.getByRole('textbox', { name: 'Message the room' })).toBeInTheDocument();
    expect(screen.getByTitle('Heat full movie')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play room' })).not.toBeInTheDocument();
    expect(screen.getByText(/Use the player controls/i)).toBeInTheDocument();
  });

  it('prevents an accidental exit and lets the host return to the same room', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    await screen.findByRole('region', { name: 'Watch party HEAT95' });

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stay in room' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave room' }));
    await waitFor(() => expect(partyService.leaveRoom).toHaveBeenCalledWith('room-1', 'user-1'));
    const resume = await screen.findByRole('button', { name: 'Resume hosting Heat' });
    fireEvent.click(resume);

    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Skully'));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('joins a room code and sends a live message', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Guest'));
    const messageBox = await screen.findByRole('textbox', { name: 'Message the room' });
    fireEvent.change(messageBox, { target: { value: 'Ready?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(partyService.sendMessage).toHaveBeenCalledWith('room-1', 'Guest', 'Ready?'));
    expect(await screen.findByText('Ready?')).toBeInTheDocument();
  });

  it('notifies readers about new chat and jumps back to the latest message', async () => {
    const partyService = makePartyService();
    let onMessage: ((message: { id: string; roomId: string; userId: string; nickname: string; body: string; createdAt: string }) => void) | undefined;
    partyService.subscribe.mockImplementation((_roomId, handlers) => {
      onMessage = handlers.onMessage;
      return () => undefined;
    });
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    const chat = await screen.findByRole('log', { name: 'Chat messages' });
    await waitFor(() => expect(partyService.subscribe).toHaveBeenCalledWith('room-1', expect.any(Object)));
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });
    fireEvent.scroll(chat);
    act(() => onMessage?.({
      id: 'message-2', roomId: 'room-1', userId: 'user-2', nickname: 'Date Night', body: 'Pick the next movie?', createdAt: '2026-08-11T00:02:00.000Z',
    }));

    const jump = await screen.findByRole('button', { name: 'Jump to latest message' });
    expect(jump).toHaveTextContent('1 new');
    expect(jump).toHaveAttribute('title', 'Date Night: Pick the next movie?');
    expect(screen.getByText('Pick the next movie?')).toBeInTheDocument();

    fireEvent.click(jump);

    expect(chat.scrollTop).toBe(900);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).not.toBeInTheDocument();
  });

  it('waits for an explicit join click when opening an invite link', async () => {
    const partyService = makePartyService();
    sessionStorage.setItem('glocktv-nickname', 'Returning guest');
    window.history.replaceState({}, '', '/?room=heat95');

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);

    await screen.findByRole('button', { name: 'Join invite' });
    expect(partyService.joinRoom).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'R' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(partyService.joinRoom).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'Returning guest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join invite' }));

    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Returning guest'));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('opens a named roster from the audience count', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));
    const roster = screen.getByRole('dialog', { name: 'People in this room' });
    expect(within(roster).getByText('Skully')).toBeInTheDocument();
    expect(within(roster).getByText('Date Night')).toBeInTheDocument();
    expect(within(roster).getByText('Host')).toBeInTheDocument();
  });

  it('lets the host mute and remove a guest from the roster', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));

    fireEvent.click(screen.getByRole('button', { name: 'Mute Date Night' }));
    await waitFor(() => expect(partyService.setMemberMuted).toHaveBeenCalledWith('room-1', 'user-2', true));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Date Night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove Date Night' }));
    await waitFor(() => expect(partyService.removeMember).toHaveBeenCalledWith('room-1', 'user-2'));
  });

  it('keeps room membership alive and exposes real sync health', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0.4, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: true, lastSeenAt: new Date().toISOString(), syncStatus: 'drifting', syncOffsetSeconds: -7, serverId: 'backup' },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    await waitFor(() => expect(partyService.heartbeatRoom).toHaveBeenCalledWith('room-1', expect.objectContaining({ syncStatus: expect.any(String) })));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));
    const roster = screen.getByRole('dialog', { name: 'People in this room' });
    expect(within(roster).getByText(/Synced/)).toBeInTheDocument();
    expect(within(roster).getByText('7s behind')).toBeInTheDocument();
    expect(within(roster).getByText('Co-host')).toBeInTheDocument();
  });

  it('lets the host promote a co-host and transfer host control', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));

    fireEvent.click(screen.getByRole('button', { name: 'Make Date Night co-host' }));
    await waitFor(() => expect(partyService.setCohost).toHaveBeenCalledWith('room-1', 'user-2', true));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer host to Date Night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm transfer host to Date Night' }));
    await waitFor(() => expect(partyService.transferHost).toHaveBeenCalledWith('room-1', 'user-2'));
  });

  it('gives the host room lock, slow mode, chat clear, and ban controls', async () => {
    const partyService = makePartyService();
    partyService.getBannedMembers.mockResolvedValue([{ userId: 'user-9', nickname: 'Removed Guest', createdAt: '2026-08-11T00:02:00.000Z' }]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Room controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock new joins' }));
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledWith('room-1', { isLocked: true, slowModeSeconds: 0 }));
    fireEvent.change(screen.getByLabelText('Chat slow mode'), { target: { value: '10' } });
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledWith('room-1', { isLocked: true, slowModeSeconds: 10 }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear room chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear room chat' }));
    await waitFor(() => expect(partyService.clearChat).toHaveBeenCalledWith('room-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow Removed Guest to rejoin' }));
    await waitFor(() => expect(partyService.unbanMember).toHaveBeenCalledWith('room-1', 'user-9'));
  });

  it('lets viewers block a member, report abuse, and request a resync', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'drifting', syncOffsetSeconds: 8, serverId: 'cinesrc' },
    ]);
    partyService.getMessages.mockResolvedValue([{ id: 'message-2', roomId: 'room-1', userId: 'user-1', nickname: 'Skully', body: 'Spoiler spam', createdAt: '2026-08-11T00:03:00.000Z' }]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Resync me' }));
    expect(screen.getByText(/Resync requested/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Report message from Skully' }));
    await waitFor(() => expect(partyService.reportMessage).toHaveBeenCalledWith('message-2', 'spam'));
    fireEvent.click(screen.getByRole('button', { name: 'Show people in this room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Block Skully' }));
    await waitFor(() => expect(partyService.blockUser).toHaveBeenCalledWith('room-1', 'user-1', true));
  });

  it('lets a guest protect their account with email and request a returning sign-in link', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Open account' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Account email' }), { target: { value: 'viewer@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Protect guest account' }));
    await waitFor(() => expect(partyService.linkEmail).toHaveBeenCalledWith('viewer@example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Email sign-in link' }));
    await waitFor(() => expect(partyService.sendSignInLink).toHaveBeenCalledWith('viewer@example.com'));
  });

  it('disables chat for a guest muted by the host', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: true },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('textbox', { name: 'Message the room' })).toBeDisabled();
    expect(screen.getByText('Muted by host')).toBeInTheDocument();
  });

  it('returns a removed guest to the lobby', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    let onMembersChanged: (() => void) | undefined;
    partyService.subscribe.mockImplementation((_roomId, handlers) => {
      onMembersChanged = handlers.onMembersChanged;
      return () => undefined;
    });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await screen.findByRole('region', { name: 'Watch party HEAT95' });

    partyService.getMembers.mockResolvedValue([]);
    onMembersChanged?.();

    expect(await screen.findByRole('heading', { name: /Movie night/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from this room.');
  });

  it('checks room state on entry when realtime delivery is delayed', async () => {
  const partyService = makePartyService();

  render(
    <App
      client={tmdbClient}
      partyService={partyService as never}
      partyPlaybackConfig={partyPlaybackConfig}
    />,
  );

  await screen.findByRole('heading', {
    name: 'Heat',
  });

  fireEvent.click(
    within(
      screen.getByRole('navigation', {
        name: 'Primary navigation',
      }),
    ).getByRole('button', {
      name: 'Friends',
    }),
  );

  fireEvent.change(
    await screen.findByLabelText(
      'Your nickname',
    ),
    {
      target: {
        value: 'Guest',
      },
    },
  );

  fireEvent.change(
    screen.getByLabelText('Room code'),
    {
      target: {
        value: 'heat95',
      },
    },
  );

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Join',
    }),
  );

  await waitFor(() =>
    expect(
      partyService.getRoom,
    ).toHaveBeenCalledWith('room-1'),
  );

  expect(
    partyService.getMembershipStatus,
  ).toHaveBeenCalledWith('room-1');

  expect(
    await screen.findByRole('region', {
      name: 'Watch party HEAT95',
    }),
  ).toBeInTheDocument();
});

  it('lets the host search for a different title and changes it for the room', async () => {
    const partyService = makePartyService();
    vi.mocked(tmdbClient.search).mockResolvedValueOnce([matrix]);
    vi.mocked(tmdbClient.getTitleContext).mockImplementationOnce(async () => ({
      trailer: { key: 'heat-trailer', site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
      details: item,
    })).mockImplementationOnce(async () => ({
      trailer: { key: 'matrix-trailer', site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
      details: matrix,
    }));

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Change title' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search watch party titles' }), { target: { value: 'Matrix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search titles' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choose The Matrix' }));

    await waitFor(() => expect(partyService.updateTitle).toHaveBeenCalledWith('room-1', {
      titleId: 603,
      mediaType: 'movie',
      titleName: 'The Matrix',
      backdropPath: '/matrix-backdrop.jpg',
      durationSeconds: 10200,
    }));
    expect(await screen.findByRole('heading', { name: 'The Matrix' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave room' }));
    expect(await screen.findByRole('button', { name: 'Resume hosting The Matrix' })).toBeInTheDocument();
  });

  it('explains that the public lounge is synchronized by an automated GlockTV host', async () => {
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
