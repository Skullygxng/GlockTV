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
};
const publicRoom = { ...room, id: 'public-1', code: 'GLOCK1', hostId: null, isPublic: true, isOfficial: true, audienceCount: 4 };
const partyPlaybackConfig = { movieUrlTemplate: 'https://party.example/movie/{tmdb_id}', tvUrlTemplate: 'https://party.example/tv/{tmdb_id}/{season_number}/{episode_number}' };

function makePartyService() {
  return {
    ensureUser: vi.fn().mockResolvedValue({ id: 'user-1' }),
    createRoom: vi.fn().mockResolvedValue(room),
    joinRoom: vi.fn().mockResolvedValue(room),
    getRoom: vi.fn().mockResolvedValue(room),
    getMembers: vi.fn().mockResolvedValue([{ userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z' }]),
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
    updateEpisode: vi.fn().mockImplementation(async (_roomId: string, seasonNumber: number, episodeNumber: number) => ({ ...room, seasonNumber, episodeNumber })),
  };
}

describe('Friends watch parties', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
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

  it('rejoins a linked room automatically when the browser already knows the nickname', async () => {
    const partyService = makePartyService();
    sessionStorage.setItem('glocktv-nickname', 'Returning guest');
    window.history.replaceState({}, '', '/?room=heat95');

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);

    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Returning guest'));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('polls room state as a fallback when realtime delivery is delayed', async () => {
    const partyService = makePartyService();
    partyService.getRoom.mockResolvedValueOnce({ ...room, playbackState: 'playing' });
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(partyService.getRoom).toHaveBeenCalledWith('room-1'));
    expect(await screen.findByText(/Playing · room clock/i)).toBeInTheDocument();
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
